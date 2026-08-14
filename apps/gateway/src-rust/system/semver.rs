struct ParsedVersion {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: Option<String>,
}

fn parse_version(input: &str) -> Option<ParsedVersion> {
    let input = input.trim();
    let (core, prerelease) = match input.split_once('-') {
        Some((core, prerelease)) if !prerelease.is_empty() => (core, Some(prerelease.to_owned())),
        _ => (input, None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(ParsedVersion {
        major,
        minor,
        patch,
        prerelease,
    })
}

/// Compare two `X.Y.Z[-prerelease]` versions. Unparseable values compare equal, matching the
/// TypeScript oracle.
pub fn compare_versions(left: &str, right: &str) -> i32 {
    let Some(left) = parse_version(left) else {
        return 0;
    };
    let Some(right) = parse_version(right) else {
        return 0;
    };
    if left.major != right.major {
        return if left.major > right.major { 1 } else { -1 };
    }
    if left.minor != right.minor {
        return if left.minor > right.minor { 1 } else { -1 };
    }
    if left.patch != right.patch {
        return if left.patch > right.patch { 1 } else { -1 };
    }
    match (left.prerelease.as_deref(), right.prerelease.as_deref()) {
        (None, None) => 0,
        (None, Some(_)) => 1,
        (Some(_), None) => -1,
        (Some(left), Some(right)) if left == right => 0,
        (Some(left), Some(right)) if left > right => 1,
        (Some(_), Some(_)) => -1,
    }
}

#[cfg(test)]
mod tests {
    use super::compare_versions;

    #[test]
    fn orders_numeric_components_and_prerelease_like_the_typescript_oracle() {
        assert_eq!(compare_versions("1.2.3", "1.2.3"), 0);
        assert_eq!(compare_versions("1.2.4", "1.2.3"), 1);
        assert_eq!(compare_versions("1.2.3", "1.3.0"), -1);
        assert_eq!(compare_versions("2.0.0", "1.9.9"), 1);
        assert_eq!(compare_versions("1.0.0", "1.0.0-beta"), 1);
        assert_eq!(compare_versions("1.0.0-alpha", "1.0.0"), -1);
        assert_eq!(compare_versions("1.0.0-beta", "1.0.0-alpha"), 1);
        assert_eq!(compare_versions("not-a-version", "1.0.0"), 0);
        assert_eq!(compare_versions("1.0.0", "also-invalid"), 0);
    }
}
