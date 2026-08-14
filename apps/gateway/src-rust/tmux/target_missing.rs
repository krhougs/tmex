use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TmuxTargetMissingError {
    message: String,
}

impl TmuxTargetMissingError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for TmuxTargetMissingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for TmuxTargetMissingError {}

pub fn is_target_missing_message(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    [
        "can't find window",
        "can't find pane",
        "no such window",
        "no such pane",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}
