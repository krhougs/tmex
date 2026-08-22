//! Pane 键盘协议模式：识别 pane 输出流中的 Kitty keyboard protocol、
//! modifyOtherKeys、DECCKM 与 bracketed paste，归并状态并持久化到 tmux pane
//! option。Gateway 以此状态在服务端编码 semantic key；客户端快照不再镜像输入模式。

/// kitty keyboard flags 栈深度上限（ghostty FlagStack 同值）。
pub const KITTY_STACK_DEPTH: usize = 8;

/// kitty flags 合法位集（ghostty `Flags = packed struct(u5)`：disambiguate /
/// event-types / alternates / report-all / associated-text）。含越界位的
/// push/set 会被客户端引擎整条忽略，检测层同口径拒绝。
pub const KITTY_FLAGS_MASK: u16 = 0b1_1111;

/// 检出的键盘协议控制序列（原始语义，不含栈运算结果）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KbdSequence {
    /// `CSI > flags u`
    PushKittyFlags(u16),
    /// `CSI < n u`（缺省 n=1）
    PopKittyFlags(u16),
    /// `CSI = flags ; mode u`（mode 缺省 1）
    SetKittyFlags { flags: u16, mode: KittySetMode },
    /// `CSI > 4 ; n m`（n=0/1/2）；`CSI > 4 m` 视为 0
    ModifyOtherKeys(u8),
    /// `CSI ? 1 h/l`（DECCKM）
    CursorKeys(bool),
    /// `CSI ? 2004 h/l`
    BracketedPaste(bool),
    /// `ESC c`（RIS）：客户端引擎复位全部键盘协议模式（kitty 栈、MoK、DECCKM、bp）
    ResetAll,
}

/// `CSI = flags ; mode u` 的 mode 参数。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KittySetMode {
    Set,
    Or,
    Not,
}

/// pane 当前键盘协议模式（snapshot 真源结构）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeyboardModeState {
    /// bottom→top。空 = kitty 协议未启用。
    pub kitty_stack: Vec<u16>,
    /// 0/1/2；0 为默认。
    pub modify_other_keys: u8,
    pub application_cursor: bool,
    pub bracketed_paste: bool,
}

impl KeyboardModeState {
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

pub fn detect_keyboard_sequence(params: &[u8], final_byte: u8) -> Option<KbdSequence> {
    match final_byte {
        b'u' => detect_kitty_u(params),
        b'm' => detect_modify_other_keys(params),
        b'h' | b'l' => detect_private_mode(params, final_byte == b'h'),
        _ => None,
    }
}

/// `>f u` / `<n u` / `=f;m u`（intermediate `>` `<` `=` 在 csi_bytes 首位）。
fn detect_kitty_u(params: &[u8]) -> Option<KbdSequence> {
    let (prefix, rest) = params.split_first()?;
    match prefix {
        b'>' => parse_flags(rest).map(KbdSequence::PushKittyFlags),
        b'<' => {
            // 参数缺省才默认 pop 1；畸形参数（如 `<;u`）客户端引擎整条忽略。
            if rest.is_empty() {
                Some(KbdSequence::PopKittyFlags(1))
            } else {
                parse_u16(rest).map(KbdSequence::PopKittyFlags)
            }
        }
        b'=' => {
            let (flags, mode) = match rest.iter().position(|&b| b == b';') {
                None => (parse_flags(rest)?, KittySetMode::Set),
                Some(sep) => {
                    let (flags_raw, mode_raw) = rest.split_at(sep);
                    let mode_raw = &mode_raw[1..];
                    let mode = if mode_raw.is_empty() {
                        KittySetMode::Set
                    } else {
                        match parse_u16(mode_raw)? {
                            1 => KittySetMode::Set,
                            2 => KittySetMode::Or,
                            3 => KittySetMode::Not,
                            _ => return None,
                        }
                    };
                    (parse_flags(flags_raw)?, mode)
                }
            };
            Some(KbdSequence::SetKittyFlags { flags, mode })
        }
        _ => None,
    }
}

/// flags 参数解析：空参数缺省 0；非空时数值必须合法且不含越界位（与客户端引擎
/// `Flags = packed struct(u5)` 同口径）。
fn parse_flags(bytes: &[u8]) -> Option<u16> {
    let flags = if bytes.is_empty() {
        0
    } else {
        parse_u16(bytes)?
    };
    (flags & !KITTY_FLAGS_MASK == 0).then_some(flags)
}
/// `>4;n m` / `>4 m`（reset → 0）。
fn detect_modify_other_keys(params: &[u8]) -> Option<KbdSequence> {
    if params.first() != Some(&b'>') {
        return None;
    }
    let rest = &params[1..];
    if rest.is_empty() {
        return None;
    }
    let (first, rest) = rest.split_first()?;
    if *first != b'4' {
        return None;
    }
    if rest.is_empty() {
        return Some(KbdSequence::ModifyOtherKeys(0));
    }
    let rest = rest.strip_prefix(&[b';'][..])?;
    match parse_u16(rest)? {
        value @ 0..=2 => Some(KbdSequence::ModifyOtherKeys(value as u8)),
        _ => None,
    }
}

/// `?1 h/l`、`?2004 h/l`；多参数合并形式不解析。
fn detect_private_mode(params: &[u8], set: bool) -> Option<KbdSequence> {
    let rest = params.strip_prefix(b"?")?;
    match rest {
        b"1" => Some(KbdSequence::CursorKeys(set)),
        b"2004" => Some(KbdSequence::BracketedPaste(set)),
        _ => None,
    }
}

/// 纯数字参数解析；空串、非数字、超 u16 均为 None。
fn parse_u16(bytes: &[u8]) -> Option<u16> {
    if bytes.is_empty() || bytes.len() > 5 {
        return None;
    }
    let mut value: u32 = 0;
    for &byte in bytes {
        let digit = (byte as char).to_digit(10)?;
        value = value * 10 + digit;
    }
    u16::try_from(value).ok()
}

/// 把检出序列归并进状态（镜像 ghostty FlagStack：8 深 ring、push 满逐出最旧、
/// pop n≥depth 全重置、set/or/not 写栈顶）。
pub fn apply_sequence(state: &mut KeyboardModeState, seq: KbdSequence) {
    match seq {
        KbdSequence::ResetAll => {
            // RIS：客户端引擎复位全部键盘协议模式（kitty 协议规范：RIS 清空栈）
            *state = KeyboardModeState::default();
        }

        KbdSequence::PushKittyFlags(flags) => {
            state.kitty_stack.push(flags);
            if state.kitty_stack.len() > KITTY_STACK_DEPTH {
                state.kitty_stack.remove(0);
            }
        }
        KbdSequence::PopKittyFlags(count) => {
            if count as usize >= KITTY_STACK_DEPTH {
                state.kitty_stack.clear();
            } else {
                let keep = state.kitty_stack.len().saturating_sub(count as usize);
                state.kitty_stack.truncate(keep);
            }
        }
        KbdSequence::SetKittyFlags { flags, mode } => {
            // ghostty FlagStack.set/or 在概念空栈上也写 flags[0]（从 disabled=0
            // 起算）；Vec 模型等价：结果非 0 时创建单元素栈，0 与空栈观感一致。
            let base = state.kitty_stack.last().copied().unwrap_or(0);
            let merged = match mode {
                KittySetMode::Set => flags,
                KittySetMode::Or => base | flags,
                KittySetMode::Not => base & !flags,
            };
            match state.kitty_stack.last_mut() {
                Some(top) => *top = merged,
                None => {
                    if merged != 0 {
                        state.kitty_stack.push(merged);
                    }
                }
            }
        }
        KbdSequence::ModifyOtherKeys(value) => state.modify_other_keys = value,
        KbdSequence::CursorKeys(enabled) => state.application_cursor = enabled,
        KbdSequence::BracketedPaste(enabled) => state.bracketed_paste = enabled,
    }
}

/// 编码为 tmux pane user option 值（`k=7,1;m=2;c=1;b=1`；默认段省略）。
pub fn encode_pane_option_value(state: &KeyboardModeState) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !state.kitty_stack.is_empty() {
        let stack = state
            .kitty_stack
            .iter()
            .map(|f| f.to_string())
            .collect::<Vec<_>>()
            .join(",");
        parts.push(format!("k={stack}"));
    }
    if state.modify_other_keys != 0 {
        parts.push(format!("m={}", state.modify_other_keys));
    }
    if state.application_cursor {
        parts.push("c=1".to_owned());
    }
    if state.bracketed_paste {
        parts.push("b=1".to_owned());
    }
    parts.join(";")
}

/// 解析 pane user option 值；残缺/越界段忽略，整体失败按全默认。
pub fn parse_pane_option_value(value: &str) -> KeyboardModeState {
    let mut state = KeyboardModeState::default();
    for part in value.split(';') {
        let Some((key, raw)) = part.split_once('=') else {
            continue;
        };
        match key {
            "k" => {
                let flags: Vec<u16> = raw
                    .split(',')
                    .filter_map(|item| item.parse::<u16>().ok())
                    .collect();
                if !flags.is_empty() {
                    state.kitty_stack = flags;
                    state.kitty_stack.truncate(KITTY_STACK_DEPTH);
                }
            }
            "m" => {
                if let Ok(level) = raw.parse::<u8>() {
                    if level <= 2 {
                        state.modify_other_keys = level;
                    }
                }
            }
            "c" => state.application_cursor = raw == "1",
            "b" => state.bracketed_paste = raw == "1",
            _ => {}
        }
    }
    state
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detect(bytes: &[u8]) -> Option<KbdSequence> {
        // bytes 形如 b">1u" / b"?1h"：参数段 + final byte
        let (params, final_byte) = bytes.split_at(bytes.len() - 1);
        detect_keyboard_sequence(params, final_byte[0])
    }

    #[test]
    fn push_pop_set_sequences_detected() {
        assert_eq!(detect(b">1u"), Some(KbdSequence::PushKittyFlags(1)));
        assert_eq!(detect(b">5u"), Some(KbdSequence::PushKittyFlags(5)));
        assert_eq!(detect(b"<1u"), Some(KbdSequence::PopKittyFlags(1)));
        assert_eq!(detect(b"<9u"), Some(KbdSequence::PopKittyFlags(9)));
        assert_eq!(
            detect(b"=7u"),
            Some(KbdSequence::SetKittyFlags {
                flags: 7,
                mode: KittySetMode::Set
            })
        );
        assert_eq!(
            detect(b"=1;2u"),
            Some(KbdSequence::SetKittyFlags {
                flags: 1,
                mode: KittySetMode::Or
            })
        );
        assert_eq!(
            detect(b"=3;3u"),
            Some(KbdSequence::SetKittyFlags {
                flags: 3,
                mode: KittySetMode::Not
            })
        );
        assert_eq!(detect(b"<u"), Some(KbdSequence::PopKittyFlags(1)));
        assert_eq!(detect(b">u"), Some(KbdSequence::PushKittyFlags(0)));
        assert_eq!(
            detect(b"=u"),
            Some(KbdSequence::SetKittyFlags {
                flags: 0,
                mode: KittySetMode::Set
            })
        );
        assert_eq!(
            detect(b"=1;u"),
            Some(KbdSequence::SetKittyFlags {
                flags: 1,
                mode: KittySetMode::Set
            })
        );
        assert_eq!(
            detect(b"=;2u"),
            Some(KbdSequence::SetKittyFlags {
                flags: 0,
                mode: KittySetMode::Or
            })
        );
    }

    #[test]
    fn unsupported_kitty_flag_bits_rejected_like_ghostty() {
        // ghostty Flags = packed u5：含越界位的 push/set 整条忽略（探针实测）
        assert_eq!(detect(b">32u"), None);
        assert_eq!(detect(b">33u"), None);
        assert_eq!(detect(b"=32u"), None);
        assert_eq!(detect(b"=33;2u"), None);
        assert_eq!(detect(b">31u"), Some(KbdSequence::PushKittyFlags(31)));
    }

    #[test]
    fn malformed_pop_param_ignored_only_empty_defaults() {
        // `<;u`（畸形参数）ghostty 忽略；`<u`（空）才默认 pop 1
        assert_eq!(detect(b"<;u"), None);
        assert_eq!(detect(b"<u"), Some(KbdSequence::PopKittyFlags(1)));
        assert_eq!(detect(b"<xu"), None);
    }

    #[test]
    fn reset_all_clears_every_tracked_mode() {
        let mut state = KeyboardModeState {
            kitty_stack: vec![7, 1],
            modify_other_keys: 2,
            application_cursor: true,
            bracketed_paste: true,
        };
        apply_sequence(&mut state, KbdSequence::ResetAll);
        assert_eq!(state, KeyboardModeState::default());
    }

    #[test]
    fn modify_other_keys_and_decset_detected() {
        assert_eq!(detect(b">4;2m"), Some(KbdSequence::ModifyOtherKeys(2)));
        assert_eq!(detect(b">4;0m"), Some(KbdSequence::ModifyOtherKeys(0)));
        assert_eq!(detect(b">4m"), Some(KbdSequence::ModifyOtherKeys(0)));
        assert_eq!(detect(b"?1h"), Some(KbdSequence::CursorKeys(true)));
        assert_eq!(detect(b"?1l"), Some(KbdSequence::CursorKeys(false)));
        assert_eq!(detect(b"?2004h"), Some(KbdSequence::BracketedPaste(true)));
        assert_eq!(detect(b"?2004l"), Some(KbdSequence::BracketedPaste(false)));
    }

    #[test]
    fn unrelated_csi_ignored() {
        assert_eq!(detect(b"?2026h"), None);
        assert_eq!(detect(b"?1049h"), None);
        assert_eq!(detect(b"2;42H"), None);
        assert_eq!(detect(b"6n"), None);
        assert_eq!(detect(b">c"), None);
        assert_eq!(detect(b"?u"), None);
        assert_eq!(detect(b"0m"), None);
        // 数字越界（u16 溢出）
        assert_eq!(detect(b">99999u"), None);
        // 多参数 DECSET 合并形式（真实程序不发，不解析）
        assert_eq!(detect(b"?1;2004h"), None);
    }

    #[test]
    fn stack_apply_mirrors_ghostty_flagstack() {
        let mut state = KeyboardModeState::default();
        apply_sequence(&mut state, KbdSequence::PushKittyFlags(1));
        apply_sequence(&mut state, KbdSequence::PushKittyFlags(5));
        assert_eq!(state.kitty_stack, vec![1, 5]);
        apply_sequence(&mut state, KbdSequence::PopKittyFlags(1));
        assert_eq!(state.kitty_stack, vec![1]);
        // 空栈 set 创建单元素栈
        let mut state = KeyboardModeState::default();
        apply_sequence(
            &mut state,
            KbdSequence::SetKittyFlags {
                flags: 7,
                mode: KittySetMode::Set,
            },
        );
        assert_eq!(state.kitty_stack, vec![7]);
        state.kitty_stack.clear();
        apply_sequence(
            &mut state,
            KbdSequence::SetKittyFlags {
                flags: 1,
                mode: KittySetMode::Or,
            },
        );
        assert_eq!(state.kitty_stack, vec![1]);
        state.kitty_stack.clear();
        // not 在空栈上结果为 0，不创建条目
        apply_sequence(
            &mut state,
            KbdSequence::SetKittyFlags {
                flags: 1,
                mode: KittySetMode::Not,
            },
        );
        assert!(state.kitty_stack.is_empty());
        for f in 1u16..=9 {
            apply_sequence(&mut state, KbdSequence::PushKittyFlags(f));
        }
        assert_eq!(state.kitty_stack, vec![2, 3, 4, 5, 6, 7, 8, 9]);
        // pop n ≥ depth 全重置
        apply_sequence(&mut state, KbdSequence::PopKittyFlags(9));
        assert!(state.kitty_stack.is_empty());
        // 空栈 pop 无害
        apply_sequence(&mut state, KbdSequence::PopKittyFlags(1));
        assert!(state.kitty_stack.is_empty());
        // or 在空栈上创建条目（ghostty 从 disabled=0 起算）
        let mut state = KeyboardModeState::default();
        apply_sequence(
            &mut state,
            KbdSequence::SetKittyFlags {
                flags: 1,
                mode: KittySetMode::Or,
            },
        );
        assert_eq!(state.kitty_stack, vec![1]);
        apply_sequence(
            &mut state,
            KbdSequence::SetKittyFlags {
                flags: 4,
                mode: KittySetMode::Or,
            },
        );
        assert_eq!(state.kitty_stack, vec![5]);
        apply_sequence(
            &mut state,
            KbdSequence::SetKittyFlags {
                flags: 4,
                mode: KittySetMode::Not,
            },
        );
        assert_eq!(state.kitty_stack, vec![1]);
    }

    #[test]
    fn decset_and_mok_apply() {
        let mut state = KeyboardModeState::default();
        apply_sequence(&mut state, KbdSequence::ModifyOtherKeys(2));
        apply_sequence(&mut state, KbdSequence::CursorKeys(true));
        apply_sequence(&mut state, KbdSequence::BracketedPaste(true));
        apply_sequence(&mut state, KbdSequence::BracketedPaste(false));
        assert_eq!(
            state,
            KeyboardModeState {
                kitty_stack: vec![],
                modify_other_keys: 2,
                application_cursor: true,
                bracketed_paste: false,
            }
        );
    }

    #[test]
    fn pane_option_value_roundtrip() {
        let codex = KeyboardModeState {
            kitty_stack: vec![7],
            modify_other_keys: 2,
            application_cursor: true,
            bracketed_paste: false,
        };
        assert_eq!(
            parse_pane_option_value(&encode_pane_option_value(&codex)),
            codex
        );
        assert_eq!(parse_pane_option_value(""), KeyboardModeState::default());
        // 残缺串按全默认
        assert_eq!(
            parse_pane_option_value("garbage"),
            KeyboardModeState::default()
        );
        // 未知段忽略
        assert_eq!(
            parse_pane_option_value("x=9;k=7"),
            KeyboardModeState {
                kitty_stack: vec![7],
                ..KeyboardModeState::default()
            }
        );
        // 深度超限 clamp
        let deep = "k=1,2,3,4,5,6,7,8,9,10";
        assert_eq!(
            parse_pane_option_value(deep).kitty_stack.len(),
            KITTY_STACK_DEPTH
        );
        // flags 越界忽略
        assert_eq!(
            parse_pane_option_value("k=99999"),
            KeyboardModeState::default()
        );
    }
}
