use std::fmt;

use tmex_protocol::{
    TerminalKey, TerminalKeyAction, TERMINAL_KEY_MOD_ALT, TERMINAL_KEY_MOD_CAPS_LOCK,
    TERMINAL_KEY_MOD_CTRL, TERMINAL_KEY_MOD_HYPER, TERMINAL_KEY_MOD_MASK, TERMINAL_KEY_MOD_META,
    TERMINAL_KEY_MOD_NUM_LOCK, TERMINAL_KEY_MOD_SHIFT, TERMINAL_KEY_MOD_SUPER,
};
use tmex_terminal::KeyboardModeState;

const KITTY_DISAMBIGUATE: u16 = 1;
const KITTY_REPORT_EVENTS: u16 = 1 << 1;
const KITTY_REPORT_ALTERNATES: u16 = 1 << 2;
const KITTY_REPORT_ALL: u16 = 1 << 3;
const REPEAT_MAX: u16 = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TerminalKeyEncodeError {
    InvalidModifierBits(u16),
    InvalidUnicode(u32),
    InvalidFunction(u8),
    InvalidRepeat(u16),
    UnsupportedRelease,
    UnsupportedLegacyModifier(u16),
    UnsupportedKey(&'static str),
}

impl fmt::Display for TerminalKeyEncodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidModifierBits(bits) => {
                write!(formatter, "invalid terminal key modifier bits: {bits:#x}")
            }
            Self::InvalidUnicode(codepoint) => {
                write!(
                    formatter,
                    "invalid terminal key Unicode scalar: {codepoint:#x}"
                )
            }
            Self::InvalidFunction(number) => {
                write!(formatter, "unsupported terminal function key: F{number}")
            }
            Self::InvalidRepeat(count) => {
                write!(
                    formatter,
                    "terminal key repeat count must be 1..={REPEAT_MAX}, got {count}"
                )
            }
            Self::UnsupportedRelease => {
                formatter.write_str("terminal key release requires Kitty event reporting")
            }
            Self::UnsupportedLegacyModifier(bits) => write!(
                formatter,
                "terminal key modifiers {bits:#x} require an enhanced keyboard mode"
            ),
            Self::UnsupportedKey(reason) => formatter.write_str(reason),
        }
    }
}

impl std::error::Error for TerminalKeyEncodeError {}

pub fn encode_terminal_key(
    key: &TerminalKey,
    modifiers: u16,
    action: &TerminalKeyAction,
    mode: &KeyboardModeState,
) -> Result<Vec<u8>, TerminalKeyEncodeError> {
    if modifiers & !TERMINAL_KEY_MOD_MASK != 0 {
        return Err(TerminalKeyEncodeError::InvalidModifierBits(modifiers));
    }
    let mut normalized_key = None;
    let modifiers = if matches!(key, TerminalKey::BackTab) {
        normalized_key = Some(TerminalKey::Tab);
        modifiers | TERMINAL_KEY_MOD_SHIFT
    } else {
        modifiers
    };
    let key = normalized_key.as_ref().unwrap_or(key);
    validate_key(key)?;
    let repetitions = match action {
        TerminalKeyAction::Press => 1,
        TerminalKeyAction::Repeat(count) if !(1..=REPEAT_MAX).contains(count) => {
            return Err(TerminalKeyEncodeError::InvalidRepeat(*count));
        }
        TerminalKeyAction::Repeat(count) => *count,
        TerminalKeyAction::Release => 1,
    };
    let event_kind = match action {
        TerminalKeyAction::Press => 1,
        TerminalKeyAction::Repeat(_) => 2,
        TerminalKeyAction::Release => 3,
    };
    let flags = mode.kitty_stack.last().copied().unwrap_or(0);
    let encoded = if flags != 0 {
        encode_kitty(key, modifiers, event_kind, flags)?
    } else if mode.modify_other_keys != 0 {
        encode_modify_other_keys(key, modifiers, event_kind, mode)?
    } else {
        encode_legacy(key, modifiers, event_kind, mode)?
    };
    let mut output = Vec::with_capacity(encoded.len().saturating_mul(repetitions as usize));
    for _ in 0..repetitions {
        output.extend_from_slice(&encoded);
    }
    Ok(output)
}

fn validate_key(key: &TerminalKey) -> Result<(), TerminalKeyEncodeError> {
    match key {
        TerminalKey::Unicode(codepoint) => {
            let Some(character) = char::from_u32(*codepoint) else {
                return Err(TerminalKeyEncodeError::InvalidUnicode(*codepoint));
            };
            if character.is_control() {
                return Err(TerminalKeyEncodeError::InvalidUnicode(*codepoint));
            }
        }
        TerminalKey::Function(number) if !(1..=35).contains(number) => {
            return Err(TerminalKeyEncodeError::InvalidFunction(*number));
        }
        TerminalKey::NumpadDigit(number) if *number > 9 => {
            return Err(TerminalKeyEncodeError::UnsupportedKey(
                "numpad digit must be in 0..=9",
            ));
        }
        _ => {}
    }
    Ok(())
}

fn encode_kitty(
    key: &TerminalKey,
    modifiers: u16,
    event_kind: u8,
    flags: u16,
) -> Result<Vec<u8>, TerminalKeyEncodeError> {
    let report_all = flags & KITTY_REPORT_ALL != 0;
    let disambiguate = flags & KITTY_DISAMBIGUATE != 0 || report_all;
    let report_events = flags & KITTY_REPORT_EVENTS != 0;
    if event_kind == 3 && !report_events {
        return Err(TerminalKeyEncodeError::UnsupportedRelease);
    }
    let event_suffix = (report_events && event_kind != 1).then_some(event_kind);

    match key {
        TerminalKey::Unicode(codepoint) => {
            let character = char::from_u32(*codepoint)
                .ok_or(TerminalKeyEncodeError::InvalidUnicode(*codepoint))?;
            let shortcut_modifiers = modifiers
                & (TERMINAL_KEY_MOD_ALT
                    | TERMINAL_KEY_MOD_CTRL
                    | TERMINAL_KEY_MOD_SUPER
                    | TERMINAL_KEY_MOD_HYPER
                    | TERMINAL_KEY_MOD_META);
            if !report_all && (!disambiguate || shortcut_modifiers == 0) {
                if event_kind == 3 {
                    return Err(TerminalKeyEncodeError::UnsupportedRelease);
                }
                return encode_text(character, modifiers);
            }
            let mut key_field = (character.to_ascii_lowercase() as u32).to_string();
            if flags & KITTY_REPORT_ALTERNATES != 0
                && modifiers & TERMINAL_KEY_MOD_SHIFT != 0
                && character.is_ascii_alphabetic()
            {
                key_field.push(':');
                key_field.push_str(&(character.to_ascii_uppercase() as u32).to_string());
            }
            Ok(csi_u(&key_field, modifiers, event_suffix))
        }
        TerminalKey::Enter | TerminalKey::Tab | TerminalKey::Backspace => {
            if !report_all
                && modifiers & !(TERMINAL_KEY_MOD_CAPS_LOCK | TERMINAL_KEY_MOD_NUM_LOCK) == 0
            {
                if event_kind == 3 {
                    return Err(TerminalKeyEncodeError::UnsupportedRelease);
                }
                return legacy_control_key(key, modifiers);
            }
            if !report_all && !disambiguate {
                return encode_legacy(key, modifiers, event_kind, &KeyboardModeState::default());
            }
            Ok(csi_u(
                &kitty_c0_code(key).to_string(),
                modifiers,
                event_suffix,
            ))
        }
        TerminalKey::Escape if disambiguate => Ok(csi_u("27", modifiers, event_suffix)),
        TerminalKey::Escape => {
            encode_legacy(key, modifiers, event_kind, &KeyboardModeState::default())
        }
        TerminalKey::Function(number @ 13..=35) => Ok(csi_u(
            &(57376u32 + u32::from(*number - 13)).to_string(),
            modifiers,
            event_suffix,
        )),
        TerminalKey::NumpadEnter
        | TerminalKey::NumpadDigit(_)
        | TerminalKey::NumpadDecimal
        | TerminalKey::NumpadAdd
        | TerminalKey::NumpadSubtract
        | TerminalKey::NumpadMultiply
        | TerminalKey::NumpadDivide
        | TerminalKey::NumpadEqual
            if disambiguate =>
        {
            Ok(csi_u(
                &kitty_private_code(key)
                    .expect("validated keypad key has a Kitty code")
                    .to_string(),
                modifiers,
                event_suffix,
            ))
        }
        TerminalKey::NumpadEnter
        | TerminalKey::NumpadDigit(_)
        | TerminalKey::NumpadDecimal
        | TerminalKey::NumpadAdd
        | TerminalKey::NumpadSubtract
        | TerminalKey::NumpadMultiply
        | TerminalKey::NumpadDivide
        | TerminalKey::NumpadEqual => {
            encode_legacy(key, modifiers, event_kind, &KeyboardModeState::default())
        }
        TerminalKey::ShiftLeft
        | TerminalKey::ShiftRight
        | TerminalKey::ControlLeft
        | TerminalKey::ControlRight
        | TerminalKey::AltLeft
        | TerminalKey::AltRight
        | TerminalKey::SuperLeft
        | TerminalKey::SuperRight
            if report_all =>
        {
            Ok(csi_u(
                &kitty_private_code(key)
                    .expect("modifier key has a Kitty code")
                    .to_string(),
                modifiers,
                event_suffix,
            ))
        }
        TerminalKey::ShiftLeft
        | TerminalKey::ShiftRight
        | TerminalKey::ControlLeft
        | TerminalKey::ControlRight
        | TerminalKey::AltLeft
        | TerminalKey::AltRight
        | TerminalKey::SuperLeft
        | TerminalKey::SuperRight => Err(TerminalKeyEncodeError::UnsupportedKey(
            "standalone modifier keys require Kitty report-all mode",
        )),
        _ => encode_functional(key, modifiers, event_suffix, false),
    }
}

fn encode_modify_other_keys(
    key: &TerminalKey,
    modifiers: u16,
    event_kind: u8,
    mode: &KeyboardModeState,
) -> Result<Vec<u8>, TerminalKeyEncodeError> {
    if event_kind == 3 {
        return Err(TerminalKeyEncodeError::UnsupportedRelease);
    }
    let unsupported =
        modifiers & (TERMINAL_KEY_MOD_SUPER | TERMINAL_KEY_MOD_HYPER | TERMINAL_KEY_MOD_META);
    if unsupported != 0 {
        return Err(TerminalKeyEncodeError::UnsupportedLegacyModifier(
            unsupported,
        ));
    }
    let effective = modifiers & !(TERMINAL_KEY_MOD_CAPS_LOCK | TERMINAL_KEY_MOD_NUM_LOCK);
    match key {
        TerminalKey::Unicode(codepoint) if effective != 0 => Ok(format!(
            "\x1b[27;{};{}~",
            modifiers + 1,
            char::from_u32(*codepoint)
                .ok_or(TerminalKeyEncodeError::InvalidUnicode(*codepoint))?
                .to_ascii_lowercase() as u32
        )
        .into_bytes()),
        TerminalKey::Enter | TerminalKey::Tab | TerminalKey::Backspace | TerminalKey::Escape
            if mode.modify_other_keys == 2 && effective != 0 =>
        {
            Ok(format!("\x1b[27;{};{}~", modifiers + 1, kitty_c0_code(key)).into_bytes())
        }
        _ => encode_legacy(key, modifiers, event_kind, mode),
    }
}

fn encode_legacy(
    key: &TerminalKey,
    modifiers: u16,
    event_kind: u8,
    mode: &KeyboardModeState,
) -> Result<Vec<u8>, TerminalKeyEncodeError> {
    if event_kind == 3 {
        return Err(TerminalKeyEncodeError::UnsupportedRelease);
    }
    let unsupported =
        modifiers & (TERMINAL_KEY_MOD_SUPER | TERMINAL_KEY_MOD_HYPER | TERMINAL_KEY_MOD_META);
    if unsupported != 0 {
        return Err(TerminalKeyEncodeError::UnsupportedLegacyModifier(
            unsupported,
        ));
    }
    match key {
        TerminalKey::Unicode(codepoint) => encode_text(
            char::from_u32(*codepoint).ok_or(TerminalKeyEncodeError::InvalidUnicode(*codepoint))?,
            modifiers,
        ),
        TerminalKey::Enter | TerminalKey::Tab | TerminalKey::Backspace => {
            legacy_control_key(key, modifiers)
        }
        TerminalKey::Escape => {
            let mut bytes = vec![0x1b];
            if modifiers & TERMINAL_KEY_MOD_ALT != 0 {
                bytes.insert(0, 0x1b);
            }
            Ok(bytes)
        }
        TerminalKey::NumpadEnter => legacy_control_key(&TerminalKey::Enter, modifiers),
        TerminalKey::NumpadDigit(number) => encode_text(char::from(b'0' + *number), modifiers),
        TerminalKey::NumpadDecimal => encode_text('.', modifiers),
        TerminalKey::NumpadAdd => encode_text('+', modifiers),
        TerminalKey::NumpadSubtract => encode_text('-', modifiers),
        TerminalKey::NumpadMultiply => encode_text('*', modifiers),
        TerminalKey::NumpadDivide => encode_text('/', modifiers),
        TerminalKey::NumpadEqual => encode_text('=', modifiers),
        TerminalKey::ShiftLeft
        | TerminalKey::ShiftRight
        | TerminalKey::ControlLeft
        | TerminalKey::ControlRight
        | TerminalKey::AltLeft
        | TerminalKey::AltRight
        | TerminalKey::SuperLeft
        | TerminalKey::SuperRight => Err(TerminalKeyEncodeError::UnsupportedKey(
            "standalone modifier keys require Kitty report-all mode",
        )),
        _ => encode_functional(key, modifiers, None, mode.application_cursor),
    }
}

fn encode_text(character: char, modifiers: u16) -> Result<Vec<u8>, TerminalKeyEncodeError> {
    let mut bytes = if modifiers & TERMINAL_KEY_MOD_CTRL != 0 {
        vec![ctrl_byte(character).ok_or(TerminalKeyEncodeError::InvalidUnicode(character as u32))?]
    } else {
        let output = if modifiers & TERMINAL_KEY_MOD_SHIFT != 0 && character.is_ascii_alphabetic() {
            character.to_ascii_uppercase()
        } else {
            character
        };
        let mut buffer = [0; 4];
        output.encode_utf8(&mut buffer).as_bytes().to_vec()
    };
    if modifiers & TERMINAL_KEY_MOD_ALT != 0 {
        bytes.insert(0, 0x1b);
    }
    Ok(bytes)
}

fn legacy_control_key(
    key: &TerminalKey,
    modifiers: u16,
) -> Result<Vec<u8>, TerminalKeyEncodeError> {
    let mut bytes = match key {
        TerminalKey::Enter if modifiers & TERMINAL_KEY_MOD_CTRL != 0 => vec![b'\n'],
        TerminalKey::Enter => vec![b'\r'],
        TerminalKey::Tab if modifiers & TERMINAL_KEY_MOD_SHIFT != 0 => b"\x1b[Z".to_vec(),
        TerminalKey::Tab => vec![b'\t'],
        TerminalKey::Backspace if modifiers & TERMINAL_KEY_MOD_CTRL != 0 => vec![0x08],
        TerminalKey::Backspace => vec![0x7f],
        _ => unreachable!("legacy control key called with a non-control key"),
    };
    if modifiers & TERMINAL_KEY_MOD_ALT != 0 {
        bytes.insert(0, 0x1b);
    }
    Ok(bytes)
}

fn encode_functional(
    key: &TerminalKey,
    modifiers: u16,
    event_kind: Option<u8>,
    application_cursor: bool,
) -> Result<Vec<u8>, TerminalKeyEncodeError> {
    let modifier_value = modifiers + 1;
    let event = event_kind.filter(|kind| *kind != 1);
    let parameter = event
        .map(|kind| format!("{modifier_value}:{kind}"))
        .unwrap_or_else(|| modifier_value.to_string());

    let final_byte = match key {
        TerminalKey::ArrowUp => Some('A'),
        TerminalKey::ArrowDown => Some('B'),
        TerminalKey::ArrowRight => Some('C'),
        TerminalKey::ArrowLeft => Some('D'),
        TerminalKey::Home => Some('H'),
        TerminalKey::End => Some('F'),
        TerminalKey::Function(1) => Some('P'),
        TerminalKey::Function(2) => Some('Q'),
        TerminalKey::Function(4) => Some('S'),
        _ => None,
    };
    if let Some(final_byte) = final_byte {
        if modifiers == 0 && event.is_none() {
            let prefix = if application_cursor { "\x1bO" } else { "\x1b[" };
            return Ok(format!("{prefix}{final_byte}").into_bytes());
        }
        return Ok(format!("\x1b[1;{parameter}{final_byte}").into_bytes());
    }

    let number = match key {
        TerminalKey::Insert => 2,
        TerminalKey::Delete => 3,
        TerminalKey::PageUp => 5,
        TerminalKey::PageDown => 6,
        TerminalKey::Function(3) => 13,
        TerminalKey::Function(5) => 15,
        TerminalKey::Function(6) => 17,
        TerminalKey::Function(7) => 18,
        TerminalKey::Function(8) => 19,
        TerminalKey::Function(9) => 20,
        TerminalKey::Function(10) => 21,
        TerminalKey::Function(11) => 23,
        TerminalKey::Function(12) => 24,
        TerminalKey::Function(number) => {
            return Err(TerminalKeyEncodeError::InvalidFunction(*number));
        }
        _ => {
            return Err(TerminalKeyEncodeError::UnsupportedKey(
                "terminal key has no functional encoding",
            ));
        }
    };
    if modifiers == 0 && event.is_none() {
        Ok(format!("\x1b[{number}~").into_bytes())
    } else {
        Ok(format!("\x1b[{number};{parameter}~").into_bytes())
    }
}

fn csi_u(key_field: &str, modifiers: u16, event_kind: Option<u8>) -> Vec<u8> {
    match event_kind {
        Some(kind) => format!("\x1b[{key_field};{}:{kind}u", modifiers + 1).into_bytes(),
        None if modifiers == 0 => format!("\x1b[{key_field}u").into_bytes(),
        None => format!("\x1b[{key_field};{}u", modifiers + 1).into_bytes(),
    }
}

fn kitty_c0_code(key: &TerminalKey) -> u32 {
    match key {
        TerminalKey::Escape => 27,
        TerminalKey::Enter => 13,
        TerminalKey::Tab => 9,
        TerminalKey::Backspace => 127,
        _ => unreachable!("kitty C0 code called with a non-C0 key"),
    }
}

fn kitty_private_code(key: &TerminalKey) -> Option<u32> {
    match key {
        TerminalKey::NumpadDigit(number @ 0..=9) => Some(57399 + u32::from(*number)),
        TerminalKey::NumpadDecimal => Some(57409),
        TerminalKey::NumpadDivide => Some(57410),
        TerminalKey::NumpadMultiply => Some(57411),
        TerminalKey::NumpadSubtract => Some(57412),
        TerminalKey::NumpadAdd => Some(57413),
        TerminalKey::NumpadEnter => Some(57414),
        TerminalKey::NumpadEqual => Some(57415),
        TerminalKey::ShiftLeft => Some(57441),
        TerminalKey::ControlLeft => Some(57442),
        TerminalKey::AltLeft => Some(57443),
        TerminalKey::SuperLeft => Some(57444),
        TerminalKey::ShiftRight => Some(57447),
        TerminalKey::ControlRight => Some(57448),
        TerminalKey::AltRight => Some(57449),
        TerminalKey::SuperRight => Some(57450),
        _ => None,
    }
}

fn ctrl_byte(character: char) -> Option<u8> {
    let byte = u8::try_from(character as u32).ok()?;
    match byte {
        b'1' | b'!' => Some(b'1'),
        b'9' | b'(' => Some(b'9'),
        b'0' | b')' => Some(b'0'),
        b'=' | b'+' => Some(b'='),
        b';' | b':' => Some(b';'),
        b'\'' | b'"' => Some(b'\''),
        b',' | b'<' => Some(b','),
        b'.' | b'>' => Some(b'.'),
        b'/' | b'-' => Some(0x1f),
        b'8' | b'?' => Some(0x7f),
        b' ' | b'2' => Some(0),
        b'3'..=b'7' => Some(byte - 0x18),
        b'@'..=b'~' => Some(byte.to_ascii_lowercase() & 0x1f),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_kitty_mok_and_legacy_vectors() {
        let kitty = KeyboardModeState {
            kitty_stack: vec![7],
            ..KeyboardModeState::default()
        };
        assert_eq!(
            encode_terminal_key(
                &TerminalKey::Enter,
                TERMINAL_KEY_MOD_SHIFT,
                &TerminalKeyAction::Press,
                &kitty,
            )
            .unwrap(),
            b"\x1b[13;2u"
        );
        assert_eq!(
            encode_terminal_key(
                &TerminalKey::ArrowUp,
                TERMINAL_KEY_MOD_CTRL | TERMINAL_KEY_MOD_SHIFT | TERMINAL_KEY_MOD_ALT,
                &TerminalKeyAction::Repeat(2),
                &kitty,
            )
            .unwrap(),
            b"\x1b[1;8:2A\x1b[1;8:2A"
        );

        let mok = KeyboardModeState {
            modify_other_keys: 2,
            ..KeyboardModeState::default()
        };
        assert_eq!(
            encode_terminal_key(
                &TerminalKey::Enter,
                TERMINAL_KEY_MOD_SHIFT,
                &TerminalKeyAction::Press,
                &mok,
            )
            .unwrap(),
            b"\x1b[27;2;13~"
        );

        let legacy = KeyboardModeState {
            application_cursor: true,
            ..KeyboardModeState::default()
        };
        assert_eq!(
            encode_terminal_key(
                &TerminalKey::ArrowLeft,
                0,
                &TerminalKeyAction::Press,
                &legacy,
            )
            .unwrap(),
            b"\x1bOD"
        );
    }
    #[test]
    fn encodes_extended_key_families_without_variant_loss() {
        let disambiguate = KeyboardModeState {
            kitty_stack: vec![1],
            ..KeyboardModeState::default()
        };
        assert_eq!(
            encode_terminal_key(
                &TerminalKey::BackTab,
                0,
                &TerminalKeyAction::Press,
                &disambiguate,
            )
            .unwrap(),
            b"\x1b[9;2u"
        );
        assert_eq!(
            encode_terminal_key(
                &TerminalKey::NumpadDigit(7),
                0,
                &TerminalKeyAction::Press,
                &disambiguate,
            )
            .unwrap(),
            b"\x1b[57406u"
        );
        assert_eq!(
            encode_terminal_key(
                &TerminalKey::Function(13),
                0,
                &TerminalKeyAction::Press,
                &disambiguate,
            )
            .unwrap(),
            b"\x1b[57376u"
        );

        let report_all = KeyboardModeState {
            kitty_stack: vec![11],
            ..KeyboardModeState::default()
        };
        assert_eq!(
            encode_terminal_key(
                &TerminalKey::ShiftLeft,
                TERMINAL_KEY_MOD_SHIFT,
                &TerminalKeyAction::Release,
                &report_all,
            )
            .unwrap(),
            b"\x1b[57441;2:3u"
        );
    }

    #[test]
    fn preserves_modifier_union_and_release_semantics() {
        let kitty = KeyboardModeState {
            kitty_stack: vec![3],
            ..KeyboardModeState::default()
        };
        assert_eq!(
            encode_terminal_key(
                &TerminalKey::ArrowDown,
                TERMINAL_KEY_MOD_CTRL | TERMINAL_KEY_MOD_SHIFT,
                &TerminalKeyAction::Release,
                &kitty,
            )
            .unwrap(),
            b"\x1b[1;6:3B"
        );
        assert!(matches!(
            encode_terminal_key(
                &TerminalKey::Enter,
                TERMINAL_KEY_MOD_SUPER,
                &TerminalKeyAction::Press,
                &KeyboardModeState::default(),
            ),
            Err(TerminalKeyEncodeError::UnsupportedLegacyModifier(_))
        ));
    }
}
