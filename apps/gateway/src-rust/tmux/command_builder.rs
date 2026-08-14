pub fn quote_shell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn join_shell_args<I, S>(values: I) -> String
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    values
        .into_iter()
        .map(|value| quote_shell_arg(value.as_ref()))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_empty_spaces_and_single_quotes_for_posix_shells() {
        assert_eq!(quote_shell_arg(""), "''");
        assert_eq!(quote_shell_arg("hello world"), "'hello world'");
        assert_eq!(quote_shell_arg("it's"), "'it'\\''s'");
        assert_eq!(
            join_shell_args(["tmux", "new; rm", "'x'"]),
            "'tmux' 'new; rm' ''\\''x'\\'''"
        );
    }
}
