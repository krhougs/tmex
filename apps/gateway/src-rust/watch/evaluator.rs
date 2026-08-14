use std::collections::HashSet;

use chrono::{DateTime, SecondsFormat, Utc};
use regress::{Flags, Regex};

use crate::entity::{watch_rule_state, watch_rules};

#[derive(Debug, Clone)]
pub struct CompiledWatchPattern {
    regex: Regex,
    sticky: bool,
    unicode: bool,
    flags: String,
}

impl CompiledWatchPattern {
    pub fn flags(&self) -> &str {
        &self.flags
    }

    pub fn find_matches(&self, screen: &str, limit: usize) -> Vec<WatchMatch> {
        if limit == 0 {
            return Vec::new();
        }

        let input = screen.encode_utf16().collect::<Vec<_>>();
        let mut matches = Vec::new();
        let mut next_index = 0;

        while next_index <= input.len() && matches.len() < limit {
            let found = if self.unicode {
                self.regex.find_from_utf16(&input, next_index).next()
            } else {
                self.regex.find_from_ucs2(&input, next_index).next()
            };
            let Some(found) = found else {
                break;
            };
            if self.sticky && found.range.start != next_index {
                break;
            }

            let start = found.range.start;
            let end = found.range.end;
            matches.push(WatchMatch {
                matched_text: decode_utf16_range(&input, found.group(0)),
                groups: (0..found.captures.len())
                    .map(|index| decode_utf16_range(&input, found.group(index + 1)))
                    .collect(),
                start_utf16: start,
                end_utf16: end,
            });

            next_index = if start == end {
                end.saturating_add(1)
            } else {
                end
            };
        }

        matches
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchMatch {
    pub matched_text: Option<String>,
    pub groups: Vec<Option<String>>,
    pub start_utf16: usize,
    pub end_utf16: usize,
}

impl WatchMatch {
    pub fn group(&self, index: usize) -> Option<&str> {
        if index == 0 {
            self.matched_text.as_deref()
        } else {
            self.groups.get(index - 1).and_then(Option::as_deref)
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WatchEvalStateUpdates {
    pub last_value: Option<Option<String>>,
    pub last_value_changed_at: Option<Option<String>>,
    pub triggered_since_change: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WatchEvalOutput {
    pub hit: bool,
    pub matched_text: Option<String>,
    pub value: Option<String>,
    pub stuck_minutes: Option<i64>,
    pub state_updates: WatchEvalStateUpdates,
    pub error: Option<String>,
}

pub fn compile_watch_pattern(
    pattern: &str,
    requested_flags: &str,
) -> Result<CompiledWatchPattern, String> {
    let mut seen = HashSet::new();
    let mut flags = String::new();
    for flag in requested_flags.chars().chain(std::iter::once('g')) {
        if !matches!(flag, 'd' | 'g' | 'i' | 'm' | 's' | 'u' | 'v' | 'y') {
            return Err(format!("invalid regular expression flag: {flag}"));
        }
        if seen.insert(flag) {
            flags.push(flag);
        }
    }
    if seen.contains(&'u') && seen.contains(&'v') {
        return Err("invalid regular expression flags: u and v are mutually exclusive".to_owned());
    }

    let unicode_sets = seen.contains(&'v');
    let regress_flags = Flags {
        icase: seen.contains(&'i'),
        multiline: seen.contains(&'m'),
        dot_all: seen.contains(&'s'),
        unicode: seen.contains(&'u') || unicode_sets,
        unicode_sets,
        ..Flags::default()
    };
    let regex = Regex::with_flags(pattern, regress_flags).map_err(|error| error.to_string())?;

    Ok(CompiledWatchPattern {
        regex,
        sticky: seen.contains(&'y'),
        unicode: seen.contains(&'u') || unicode_sets,
        flags: canonical_flags(&seen),
    })
}

pub fn find_last_match(screen: &str, pattern: &CompiledWatchPattern) -> Option<WatchMatch> {
    pattern.find_matches(screen, usize::MAX).pop()
}

pub fn evaluate_watch_rule(
    screen: &str,
    rule: &watch_rules::Model,
    state: Option<&watch_rule_state::Model>,
    now: DateTime<Utc>,
) -> WatchEvalOutput {
    if rule.trigger_type == "llm" {
        return WatchEvalOutput {
            error: Some("llm rules are not handled by the regex evaluator".to_owned()),
            ..WatchEvalOutput::default()
        };
    }

    let Some(pattern) = rule
        .pattern
        .as_deref()
        .filter(|pattern| !pattern.is_empty())
    else {
        return WatchEvalOutput {
            error: Some("pattern is empty".to_owned()),
            ..WatchEvalOutput::default()
        };
    };
    let pattern = match compile_watch_pattern(pattern, &rule.pattern_flags) {
        Ok(pattern) => pattern,
        Err(error) => {
            return WatchEvalOutput {
                error: Some(format!("invalid pattern: {error}")),
                ..WatchEvalOutput::default()
            };
        }
    };
    let matched = find_last_match(screen, &pattern);

    if rule.trigger_type == "match" {
        let Some(matched) = matched else {
            return WatchEvalOutput::default();
        };
        return WatchEvalOutput {
            hit: passes_trigger_gate(rule, state, now.timestamp_millis()),
            matched_text: matched.matched_text,
            ..WatchEvalOutput::default()
        };
    }

    let extract_group = rule.extract_group.max(0) as usize;
    let value = matched
        .as_ref()
        .and_then(|matched| matched.group(extract_group))
        .map(ToOwned::to_owned);
    let Some(value) = value else {
        let should_reset = rule.no_match_behavior == "reset"
            && state.is_some_and(|state| {
                state.last_value.is_some()
                    || state.last_value_changed_at.is_some()
                    || state.triggered_since_change != 0
            });
        return WatchEvalOutput {
            state_updates: if should_reset {
                WatchEvalStateUpdates {
                    last_value: Some(None),
                    last_value_changed_at: Some(None),
                    triggered_since_change: Some(false),
                }
            } else {
                WatchEvalStateUpdates::default()
            },
            ..WatchEvalOutput::default()
        };
    };

    let last_value = state.and_then(|state| state.last_value.as_deref());
    let last_changed_at = state
        .and_then(|state| state.last_value_changed_at.as_deref())
        .and_then(parse_timestamp_millis);
    let matched_text = matched.and_then(|matched| matched.matched_text);
    let Some(last_changed_at) = last_changed_at.filter(|_| last_value == Some(value.as_str()))
    else {
        return WatchEvalOutput {
            value: Some(value.clone()),
            matched_text,
            state_updates: WatchEvalStateUpdates {
                last_value: Some(Some(value)),
                last_value_changed_at: Some(Some(to_iso_string(now))),
                triggered_since_change: Some(false),
            },
            ..WatchEvalOutput::default()
        };
    };

    let elapsed_ms = i128::from(now.timestamp_millis()) - i128::from(last_changed_at);
    let unchanged_minutes = rule.unchanged_minutes.unwrap_or(0);
    if unchanged_minutes <= 0 || elapsed_ms < i128::from(unchanged_minutes) * 60_000 {
        return WatchEvalOutput {
            value: Some(value),
            matched_text,
            ..WatchEvalOutput::default()
        };
    }
    if !passes_trigger_gate(rule, state, now.timestamp_millis()) {
        return WatchEvalOutput {
            value: Some(value),
            matched_text,
            ..WatchEvalOutput::default()
        };
    }

    WatchEvalOutput {
        hit: true,
        value: Some(value),
        matched_text,
        stuck_minutes: Some((elapsed_ms / 60_000).try_into().unwrap_or(i64::MAX)),
        ..WatchEvalOutput::default()
    }
}

fn passes_trigger_gate(
    rule: &watch_rules::Model,
    state: Option<&watch_rule_state::Model>,
    now_millis: i64,
) -> bool {
    if rule.fire_mode == "once" {
        return rule.trigger_type != "unchanged"
            || state.is_none_or(|state| state.triggered_since_change == 0);
    }

    let Some(last_triggered_at) = state
        .and_then(|state| state.last_triggered_at.as_deref())
        .and_then(parse_timestamp_millis)
    else {
        return true;
    };
    let elapsed = i128::from(now_millis) - i128::from(last_triggered_at);
    elapsed >= i128::from(rule.cooldown_seconds.max(0)) * 1_000
}

fn decode_utf16_range(input: &[u16], range: Option<std::ops::Range<usize>>) -> Option<String> {
    range.map(|range| String::from_utf16_lossy(&input[range]))
}

fn parse_timestamp_millis(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.timestamp_millis())
}

fn to_iso_string(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn canonical_flags(flags: &HashSet<char>) -> String {
    "dgimsuvy"
        .chars()
        .filter(|flag| flags.contains(flag))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(trigger_type: &str, pattern: &str) -> watch_rules::Model {
        watch_rules::Model {
            id: "rule-1".to_owned(),
            name: "test rule".to_owned(),
            device_id: "device-1".to_owned(),
            pane_id: "%1".to_owned(),
            enabled: 1,
            trigger_type: trigger_type.to_owned(),
            pattern: Some(pattern.to_owned()),
            pattern_flags: String::new(),
            extract_group: 0,
            condition_prompt: None,
            provider_id: None,
            model_id: None,
            confirm_with_llm: 0,
            summarize_with_llm: 0,
            interval_seconds: 30,
            unchanged_minutes: None,
            no_match_behavior: "reset".to_owned(),
            fire_mode: "once".to_owned(),
            cooldown_seconds: 600,
            created_at: "2026-06-13T12:00:00.000Z".to_owned(),
            updated_at: "2026-06-13T12:00:00.000Z".to_owned(),
        }
    }

    fn state() -> watch_rule_state::Model {
        watch_rule_state::Model {
            rule_id: "rule-1".to_owned(),
            last_sampled_at: None,
            last_value: None,
            last_value_changed_at: None,
            triggered_since_change: 0,
            last_triggered_at: None,
            consecutive_errors: 0,
            last_error: None,
            model_unavailable_notified: 0,
        }
    }

    fn now() -> DateTime<Utc> {
        "2026-06-13T12:00:00.000Z".parse().unwrap()
    }

    #[test]
    fn supports_ecmascript_backreferences_lookbehind_and_sticky_matching() {
        let pattern = compile_watch_pattern(r"(?<=progress: )(\d+)\s+\1", "y").unwrap();
        assert!(find_last_match("progress: 42 42", &pattern).is_none());

        let pattern = compile_watch_pattern(r"(?<=progress: )(\d+)\s+\1", "").unwrap();
        let matched = find_last_match("progress: 42 42", &pattern).unwrap();
        assert_eq!(matched.matched_text.as_deref(), Some("42 42"));
        assert_eq!(matched.group(1), Some("42"));
    }

    #[test]
    fn applies_javascript_utf16_global_iteration_and_flag_validation() {
        let legacy = compile_watch_pattern(".", "").unwrap();
        let unicode = compile_watch_pattern(".", "u").unwrap();
        assert_eq!(legacy.find_matches("😀", 8).len(), 2);
        assert_eq!(unicode.find_matches("😀", 8).len(), 1);
        assert!(compile_watch_pattern(".", "uv").is_err());
        assert!(compile_watch_pattern(".", "q").is_err());
        assert_eq!(compile_watch_pattern(".", "ggi").unwrap().flags(), "gi");
    }

    #[test]
    fn evaluates_unchanged_state_and_trigger_gates() {
        let mut rule = rule("unchanged", r"(\d+)%");
        rule.extract_group = 1;
        rule.unchanged_minutes = Some(10);

        let first = evaluate_watch_rule("progress 42%", &rule, None, now());
        assert!(!first.hit);
        assert_eq!(first.value.as_deref(), Some("42"));
        assert_eq!(first.state_updates.last_value, Some(Some("42".to_owned())));

        let mut state = state();
        state.last_value = Some("42".to_owned());
        state.last_value_changed_at = Some("2026-06-13T11:35:00.000Z".to_owned());
        let fired = evaluate_watch_rule("progress 42%", &rule, Some(&state), now());
        assert!(fired.hit);
        assert_eq!(fired.stuck_minutes, Some(25));

        state.triggered_since_change = 1;
        assert!(!evaluate_watch_rule("progress 42%", &rule, Some(&state), now()).hit);
    }
}
