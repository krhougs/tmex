//! Pane 键盘协议模式：对 pane 输出流中 kitty keyboard protocol / modifyOtherKeys /
//! DECCKM / bracketed paste 控制序列的无状态识别、状态归并（镜像 ghostty
//! terminal/Kitty/key.zig FlagStack 语义）、快照恢复序列生成与 tmux pane
//! user option 编解码。
//!
//! gateway 在控制连接生命周期内用 [`detect_keyboard_sequence`] 检出序列事件，
//! 由 device_session_runtime 持有唯一状态真源；状态经 pane user option 跨
//! gateway 重启持久化。恢复序列追加进 canonical 快照 data 字节流，客户端
//! 引擎重放快照即还原编码器模式状态。

/// kitty keyboard flags 栈深度上限（ghostty FlagStack 同值）。
pub const KITTY_STACK_DEPTH: usize = 8;

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
        b'>' => parse_u16(rest).map(KbdSequence::PushKittyFlags),
        b'<' => parse_u16(rest).or(Some(1)).map(KbdSequence::PopKittyFlags),
        b'=' => {
            let (flags, mode) = match rest.iter().position(|&b| b == b';') {
                None => (parse_u16(rest)?, KittySetMode::Set),
                Some(sep) => {
                    let (flags_raw, mode_raw) = rest.split_at(sep);
                    let mode = match parse_u16(&mode_raw[1..])? {
                        1 => KittySetMode::Set,
                        2 => KittySetMode::Or,
                        3 => KittySetMode::Not,
                        _ => return None,
                    };
                    (parse_u16(flags_raw)?, mode)
                }
            };
            Some(KbdSequence::SetKittyFlags { flags, mode })
        }
        _ => None,
    }
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
pub fn apply_sequence(state: &mut KeyboardModeState, seq: KbdSequence) {
    match seq {
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
/// 生成快照恢复序列（只发非默认值；客户端引擎 reset() 后默认即全零）。
/// kitty 栈：`CSI = f u` set 重建栈底 + 逐层 `CSI > f u` push，
/// 对良构程序序列与真实序列流逐事件等价。
pub fn keyboard_restore_sequences(state: &KeyboardModeState) -> Vec<u8> {
    let mut out = Vec::new();
    if let Some((&bottom, rest)) = state.kitty_stack.split_first() {
        out.extend_from_slice(format!("\x1b[={bottom}u").as_bytes());
        for &flags in rest {
            out.extend_from_slice(format!("\x1b[>{flags}u").as_bytes());
        }
    }
    match state.modify_other_keys {
        0 => {}
        level => out.extend_from_slice(format!("\x1b[>4;{level}m").as_bytes()),
    }
    if state.application_cursor {
        out.extend_from_slice(b"\x1b[?1h");
    }
    if state.bracketed_paste {
        out.extend_from_slice(b"\x1b[?2004h");
    }
    out
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
    fn restore_sequences_only_non_default() {
        assert!(keyboard_restore_sequences(&KeyboardModeState::default()).is_empty());
        // Codex 形态：单层栈 [7] + MoK=2 + DECCKM
        let codex = KeyboardModeState {
            kitty_stack: vec![7],
            modify_other_keys: 2,
            application_cursor: true,
            bracketed_paste: false,
        };
        assert_eq!(
            keyboard_restore_sequences(&codex),
            b"\x1b[=7u\x1b[>4;2m\x1b[?1h"
        );
        // 多层栈：set 重建栈底 + push 逐层
        let nested = KeyboardModeState {
            kitty_stack: vec![1, 7],
            ..KeyboardModeState::default()
        };
        assert_eq!(keyboard_restore_sequences(&nested), b"\x1b[=1u\x1b[>7u");
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
