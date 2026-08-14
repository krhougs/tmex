pub const WINDOW_STYLE_PATTERN_DESCRIPTION: &str = "[A-Za-z0-9#=,]+";

pub fn resolve_tmux_window_style(value: &str) -> Option<String> {
    let style = value.trim();
    if style.is_empty() || style.eq_ignore_ascii_case("off") {
        return None;
    }
    style
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'#' | b'=' | b','))
        .then(|| style.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_accepts_the_tmux_style_command_safe_subset() {
        assert_eq!(
            resolve_tmux_window_style(" fg=#fff,bg=black ").as_deref(),
            Some("fg=#fff,bg=black")
        );
        assert_eq!(resolve_tmux_window_style("off"), None);
        assert_eq!(resolve_tmux_window_style("fg=red;run-shell whoami"), None);
        assert_eq!(resolve_tmux_window_style("fg='red'"), None);
    }
}
