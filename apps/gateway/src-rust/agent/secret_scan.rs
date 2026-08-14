use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::{Captures, Regex};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretMatch {
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RedactedText {
    pub text: String,
    pub matches: Vec<SecretMatch>,
}

struct SecretPatterns {
    private_key: Regex,
    url_credential: Regex,
    bearer_token: Regex,
    api_token: Regex,
    typed_device_secret: Regex,
    enable_secret: Regex,
    snmp_secret: Regex,
}

static SECRET_PATTERNS: LazyLock<Result<SecretPatterns, regex::Error>> = LazyLock::new(|| {
    Ok(SecretPatterns {
        private_key: Regex::new(
            r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
        )?,
        url_credential: Regex::new(r"(?i)\b([a-z][a-z0-9+.-]*://[^\s/:@]+:)([^\s/@]+)@")?,
        bearer_token: Regex::new(r"(?i)(Authorization:\s*Bearer\s+)([A-Za-z0-9._~+/-]+=*)")?,
        api_token: Regex::new(
            r"(?:sk-[A-Za-z0-9_-]{16,}|gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ya29\.[A-Za-z0-9._-]{20,}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{18,})",
        )?,
        typed_device_secret: Regex::new(r"(?i)\b(password|secret)\s+([0-9])\s+(\S+)")?,
        enable_secret: Regex::new(r"(?i)\b(enable\s+secret)\s+(?:[0-9]\s+)?(\S+)")?,
        snmp_secret: Regex::new(r"(?i)\b(snmp-server\s+community)\s+(\S+)")?,
    })
});

fn marker(kind: &str) -> String {
    format!("[REDACTED:{kind}]")
}

fn replace_and_record<F>(
    text: String,
    regex: &Regex,
    kind: &str,
    matches: &mut Vec<SecretMatch>,
    replacement: F,
) -> String
where
    F: Fn(&Captures<'_>) -> String,
{
    regex
        .replace_all(&text, |captures: &Captures<'_>| {
            matches.push(SecretMatch {
                kind: kind.to_owned(),
            });
            replacement(captures)
        })
        .into_owned()
}

pub fn redact_secrets(input: &str) -> RedactedText {
    if input.is_empty() {
        return RedactedText {
            text: String::new(),
            matches: Vec::new(),
        };
    }

    let Ok(patterns) = &*SECRET_PATTERNS else {
        return RedactedText {
            text: marker("secret-scan-unavailable"),
            matches: vec![SecretMatch {
                kind: "secret-scan-unavailable".to_owned(),
            }],
        };
    };

    let mut matches = Vec::new();
    let mut text = input.to_owned();
    text = replace_and_record(
        text,
        &patterns.private_key,
        "private-key",
        &mut matches,
        |_| marker("private-key"),
    );
    text = replace_and_record(
        text,
        &patterns.url_credential,
        "url-credential",
        &mut matches,
        |caps| format!("{}{}@", &caps[1], marker("password")),
    );
    text = replace_and_record(
        text,
        &patterns.bearer_token,
        "bearer-token",
        &mut matches,
        |caps| format!("{}{}", &caps[1], marker("token")),
    );
    text = replace_and_record(text, &patterns.api_token, "api-token", &mut matches, |_| {
        marker("token")
    });
    text = replace_and_record(
        text,
        &patterns.typed_device_secret,
        "device-secret",
        &mut matches,
        |caps| format!("{} {} {}", &caps[1], &caps[2], marker("device-secret")),
    );
    text = replace_and_record(
        text,
        &patterns.enable_secret,
        "device-secret",
        &mut matches,
        |caps| format!("{} {}", &caps[1], marker("device-secret")),
    );
    text = replace_and_record(
        text,
        &patterns.snmp_secret,
        "device-secret",
        &mut matches,
        |caps| format!("{} {}", &caps[1], marker("device-secret")),
    );
    RedactedText { text, matches }
}

pub fn detect_secrets(input: &str) -> Vec<SecretMatch> {
    redact_secrets(input).matches
}

pub fn secret_kinds(input: &str) -> Vec<String> {
    detect_secrets(input)
        .into_iter()
        .map(|found| found.kind)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

pub fn has_secret(input: &str) -> bool {
    !detect_secrets(input).is_empty()
}

pub fn redact_known_secret(input: &str, secret: Option<&str>) -> String {
    let without_known = secret.filter(|value| !value.is_empty()).map_or_else(
        || input.to_owned(),
        |secret| input.replace(secret, "[REDACTED:provider-api-key]"),
    );
    redact_secrets(&without_known).text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_high_confidence_credentials_without_retaining_values() {
        let private_key = "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----";
        let input = format!(
            "{private_key}\nAuthorization: Bearer abc.def-123\npostgres://alice:hunter2@db/x\npassword 7 0822455D0A16\nenable secret 5 hash\nsnmp-server community public\nsk-abcdefghijklmnop"
        );
        let redacted = redact_secrets(&input);
        for secret in [
            "abc123",
            "abc.def-123",
            "hunter2",
            "0822455D0A16",
            "hash",
            "public",
            "sk-abcdefghijklmnop",
        ] {
            assert!(!redacted.text.contains(secret));
        }
        assert!(redacted.matches.len() >= 7);
        assert!(!format!("{:?}", redacted.matches).contains("hunter2"));
    }

    #[test]
    fn avoids_low_confidence_false_positives_and_redacts_exact_provider_secret() {
        for sample in [
            "password: use your own value",
            "token budget is 4096",
            "secret sauce",
            "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ",
        ] {
            assert_eq!(redact_secrets(sample).text, sample);
        }
        assert_eq!(
            redact_known_secret("request failed for sk-short", Some("sk-short")),
            "request failed for [REDACTED:provider-api-key]"
        );
    }
}
