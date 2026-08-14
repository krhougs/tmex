use std::cmp::Ordering;
use std::sync::OnceLock;

use icu_collator::options::{CollatorOptions, Strength};
use icu_collator::preferences::CollationNumericOrdering;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};
use icu_locale::locale;
use regex::Regex;

use super::{
    FileCategory, FileEntry, FileEntryType, FileErrorCode, PreparedRsyncDevice, RsyncEntry,
    RsyncProgress,
};
use crate::files::categorize;
use crate::files::path::posix_join;

pub fn parse_rsync_progress(line: &str) -> Option<RsyncProgress> {
    static PROGRESS: OnceLock<Option<Regex>> = OnceLock::new();
    let regex = PROGRESS
        .get_or_init(|| Regex::new(r"^\s*([\d,]+)\s+(\d+)%\s+([\d.]+[KMGT]?B/s)").ok())
        .as_ref()?;
    let captures = regex.captures(line)?;
    let transferred = captures.get(1)?.as_str().replace(',', "").parse().ok()?;
    let pct = captures.get(2)?.as_str().parse().ok()?;
    Some(RsyncProgress {
        transferred,
        pct,
        rate: captures.get(3)?.as_str().to_owned(),
    })
}

pub fn parse_list_only(stdout: &str) -> Vec<RsyncEntry> {
    static LIST: OnceLock<Option<Regex>> = OnceLock::new();
    let regex = LIST.get_or_init(|| {
        Regex::new(
            r"^([dlspbc-][rwxsStT-]{9}[.+@]?)\s+([\d,]+)\s+(\d{4})/(\d{2})/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+(.*)$",
        )
        .ok()
    });
    let Some(regex) = regex else {
        return Vec::new();
    };
    stdout
        .lines()
        .filter_map(|line| {
            let captures = regex.captures(line.trim_end_matches('\r'))?;
            let entry_type = match captures.get(1)?.as_str().as_bytes()[0] {
                b'd' => FileEntryType::Dir,
                b'l' => FileEntryType::Symlink,
                b'-' => FileEntryType::File,
                _ => FileEntryType::Other,
            };
            let mut name = unescape_octal(captures.get(9)?.as_str());
            if entry_type == FileEntryType::Symlink {
                if let Some((link_name, _)) = name.split_once(" -> ") {
                    name = link_name.to_owned();
                }
            }
            if name.is_empty() || matches!(name.as_str(), "." | "..") {
                return None;
            }
            let size = if entry_type == FileEntryType::Dir {
                None
            } else {
                captures.get(2)?.as_str().replace(',', "").parse().ok()
            };
            Some(RsyncEntry {
                name,
                entry_type,
                size,
                modified_at: Some(format!(
                    "{}-{}-{}T{}:{}:{}",
                    captures.get(3)?.as_str(),
                    captures.get(4)?.as_str(),
                    captures.get(5)?.as_str(),
                    captures.get(6)?.as_str(),
                    captures.get(7)?.as_str(),
                    captures.get(8)?.as_str(),
                )),
            })
        })
        .collect()
}

fn unescape_octal(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = String::new();
    let mut pending = Vec::new();
    let mut index = 0;
    let flush = |pending: &mut Vec<u8>, output: &mut String| {
        if !pending.is_empty() {
            output.push_str(&String::from_utf8_lossy(pending));
            pending.clear();
        }
    };
    while index < bytes.len() {
        if bytes[index] != b'\\' {
            flush(&mut pending, &mut output);
            let rest = &input[index..];
            let Some(character) = rest.chars().next() else {
                break;
            };
            output.push(character);
            index += character.len_utf8();
        } else if bytes.get(index + 1) == Some(&b'\\') {
            flush(&mut pending, &mut output);
            output.push('\\');
            index += 2;
        } else if let Some(digits) = bytes.get(index + 1..index + 4) {
            if digits.iter().all(|digit| matches!(digit, b'0'..=b'7')) {
                pending.push((digits[0] - b'0') * 64 + (digits[1] - b'0') * 8 + digits[2] - b'0');
                index += 4;
            } else {
                flush(&mut pending, &mut output);
                output.push('\\');
                index += 1;
            }
        } else {
            flush(&mut pending, &mut output);
            output.push('\\');
            index += 1;
        }
    }
    flush(&mut pending, &mut output);
    output
}

pub fn classify_rsync_failure(exit_code: i32, stderr: &str) -> FileErrorCode {
    let stderr = stderr.to_ascii_lowercase();
    if exit_code == 124 {
        return FileErrorCode::Timeout;
    }
    if stderr.contains("command not found")
        || stderr.contains("rsync: not found")
        || (stderr.contains("rsync error: error in rsync protocol") && stderr.contains("code 127"))
        || stderr.contains("exec: rsync: not found")
        || stderr.contains("bash: rsync")
    {
        return FileErrorCode::RsyncMissingRemote;
    }
    if [
        "host key verification failed",
        "could not resolve hostname",
        "connection refused",
        "connection timed out",
        "no route to host",
        "operation timed out",
        "ssh: connect to host",
        "too many authentication failures",
        "authentication failed",
    ]
    .iter()
    .any(|needle| stderr.contains(needle))
        || [
            "permission denied (publickey",
            "permission denied (password",
            "permission denied (keyboard-interactive",
            "permission denied (gssapi",
            "permission denied (hostbased",
        ]
        .iter()
        .any(|needle| stderr.contains(needle))
    {
        return FileErrorCode::ConnectionFailed;
    }
    if stderr.contains("permission denied") {
        return FileErrorCode::PermissionDenied;
    }
    if [
        "no such file or directory",
        "change_dir",
        "link_stat",
        "failed to stat",
    ]
    .iter()
    .any(|needle| stderr.contains(needle))
    {
        return FileErrorCode::NotFound;
    }
    FileErrorCode::Unknown
}

pub fn rsync_list_args(spec: &PreparedRsyncDevice, remote_path: &str) -> Vec<String> {
    let mut args = vec!["--list-only".to_owned(), "--8-bit-output".to_owned()];
    append_rsh(&mut args, spec);
    args.push(rsync_target_arg(spec, remote_path));
    args
}

pub fn rsync_copy_args(
    spec: &PreparedRsyncDevice,
    remote_path: &str,
    destination: &str,
) -> Vec<String> {
    let mut args = vec!["-L".to_owned(), "--progress".to_owned()];
    append_rsh(&mut args, spec);
    args.extend([rsync_target_arg(spec, remote_path), destination.to_owned()]);
    args
}

pub fn rsync_upload_args(
    spec: &PreparedRsyncDevice,
    local_source: &str,
    remote_destination: &str,
) -> Vec<String> {
    let mut args = vec!["--progress".to_owned()];
    append_rsh(&mut args, spec);
    args.extend([
        local_source.to_owned(),
        rsync_target_arg(spec, remote_destination),
    ]);
    args
}

fn append_rsh(args: &mut Vec<String>, spec: &PreparedRsyncDevice) {
    if let Some(rsh) = &spec.rsh {
        args.extend(["-e".to_owned(), rsh.clone()]);
    }
}

fn rsync_target_arg(spec: &PreparedRsyncDevice, remote_path: &str) -> String {
    if spec.target_prefix.is_empty() {
        remote_path.to_owned()
    } else {
        format!("{}{}", spec.target_prefix, quote_shell_arg(remote_path))
    }
}

fn quote_shell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn entries_to_response(entries: Vec<RsyncEntry>, parent: &str) -> Vec<FileEntry> {
    let mut entries = entries
        .into_iter()
        .map(|entry| FileEntry {
            path: posix_join(parent, &entry.name),
            category: if entry.entry_type == FileEntryType::Dir {
                FileCategory::Directory
            } else {
                categorize(&entry.name)
            },
            is_symlink: entry.entry_type == FileEntryType::Symlink,
            name: entry.name,
            entry_type: entry.entry_type,
            size: entry.size,
            modified_at: entry.modified_at,
        })
        .collect::<Vec<_>>();
    let collator = file_name_collator();
    entries.sort_by(|left, right| {
        let left_rank = usize::from(left.entry_type != FileEntryType::Dir);
        let right_rank = usize::from(right.entry_type != FileEntryType::Dir);
        left_rank.cmp(&right_rank).then_with(|| {
            collator.map_or_else(
                || natural_cmp(&left.name, &right.name),
                |collator| collator.compare(&left.name, &right.name),
            )
        })
    });
    entries
}

fn file_name_collator() -> Option<&'static CollatorBorrowed<'static>> {
    static COLLATOR: OnceLock<Option<CollatorBorrowed<'static>>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            let mut preferences: CollatorPreferences = locale!("en-US").into();
            preferences.numeric_ordering = Some(CollationNumericOrdering::True);
            let mut options = CollatorOptions::default();
            options.strength = Some(Strength::Primary);
            Collator::try_new(preferences, options).ok()
        })
        .as_ref()
}

fn natural_cmp(left: &str, right: &str) -> Ordering {
    let left = left.to_lowercase();
    let right = right.to_lowercase();
    let mut left = left.as_bytes().iter().copied().peekable();
    let mut right = right.as_bytes().iter().copied().peekable();
    loop {
        match (left.peek(), right.peek()) {
            (Some(a), Some(b)) if a.is_ascii_digit() && b.is_ascii_digit() => {
                let mut a_digits = Vec::new();
                let mut b_digits = Vec::new();
                while left.peek().is_some_and(u8::is_ascii_digit) {
                    if let Some(digit) = left.next() {
                        a_digits.push(digit);
                    }
                }
                while right.peek().is_some_and(u8::is_ascii_digit) {
                    if let Some(digit) = right.next() {
                        b_digits.push(digit);
                    }
                }
                let a_trimmed = a_digits
                    .iter()
                    .position(|value| *value != b'0')
                    .map_or(&a_digits[a_digits.len()..], |index| &a_digits[index..]);
                let b_trimmed = b_digits
                    .iter()
                    .position(|value| *value != b'0')
                    .map_or(&b_digits[b_digits.len()..], |index| &b_digits[index..]);
                let order = a_trimmed
                    .len()
                    .cmp(&b_trimmed.len())
                    .then_with(|| a_trimmed.cmp(b_trimmed))
                    .then_with(|| a_digits.len().cmp(&b_digits.len()));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(_), Some(_)) => {
                let order = left.next().cmp(&right.next());
                if order != Ordering::Equal {
                    return order;
                }
            }
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
        }
    }
}
