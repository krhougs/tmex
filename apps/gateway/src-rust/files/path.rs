use std::path::Path;

use super::{FileError, FileErrorCode, FileResult};

pub fn posix_normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut output = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." if output.last().is_some_and(|last| *last != "..") => {
                output.pop();
            }
            ".." if !absolute => output.push(segment),
            ".." => {}
            _ => output.push(segment),
        }
    }
    let joined = output.join("/");
    if absolute {
        format!("/{joined}")
    } else {
        joined
    }
}

pub fn posix_join(directory: &str, name: &str) -> String {
    if directory == "/" {
        format!("/{name}")
    } else {
        format!("{directory}/{name}")
    }
}

pub fn posix_basename(path: &str) -> String {
    path.rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or(path)
        .to_owned()
}

pub fn sanitize_upload_name(raw: &str) -> Option<String> {
    let name = raw.rsplit('/').next().unwrap_or_default();
    if name.is_empty()
        || matches!(name, "." | "..")
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        None
    } else {
        Some(name.to_owned())
    }
}

pub async fn check_and_normalize(
    device_type: &str,
    root_path: &str,
    input_path: &str,
) -> FileResult<String> {
    if input_path.is_empty() || !input_path.starts_with('/') {
        return Err(FileError::code(FileErrorCode::Invalid));
    }
    let root = posix_normalize(root_path);
    let target = posix_normalize(input_path);
    let inside = if root == "/" {
        target.starts_with('/')
    } else {
        target == root
            || target
                .strip_prefix(&root)
                .is_some_and(|rest| rest.starts_with('/'))
    };
    if !inside {
        return Err(FileError::code(FileErrorCode::OutsideRoots));
    }

    if device_type == "local" {
        let real_root = tokio::fs::canonicalize(&root)
            .await
            .map_err(|_| FileError::code(FileErrorCode::RootNotFound))?;
        let real_target = tokio::fs::canonicalize(&target)
            .await
            .map_err(|_| FileError::code(FileErrorCode::NotFound))?;
        if real_target != real_root && !real_target.starts_with(Path::new(&real_root)) {
            return Err(FileError::code(FileErrorCode::OutsideRoots));
        }
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ssh_paths_use_posix_containment_not_sibling_prefixes() {
        assert_eq!(
            check_and_normalize("ssh", "/srv/data", "/srv/data/a/../b")
                .await
                .expect("contained path"),
            "/srv/data/b"
        );
        assert_eq!(
            check_and_normalize("ssh", "/srv/data", "/srv/database/file")
                .await
                .expect_err("sibling prefix must be rejected")
                .code,
            FileErrorCode::OutsideRoots
        );
        assert_eq!(
            check_and_normalize("ssh", "/srv/data", "/srv/data/../../etc/passwd")
                .await
                .expect_err("traversal must be rejected")
                .code,
            FileErrorCode::OutsideRoots
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_symlink_cannot_escape_the_canonical_root() {
        use std::os::unix::fs::symlink;

        let base = tempfile::tempdir().expect("temp directory");
        let root = base.path().join("root");
        let outside = base.path().join("outside");
        std::fs::create_dir_all(&root).expect("create root");
        std::fs::create_dir_all(&outside).expect("create outside");
        std::fs::write(outside.join("secret"), b"secret").expect("create target");
        symlink(&outside, root.join("escape")).expect("create symlink");

        let error = check_and_normalize(
            "local",
            root.to_str().expect("UTF-8 root"),
            root.join("escape/secret").to_str().expect("UTF-8 target"),
        )
        .await
        .expect_err("canonical escape must fail");
        assert_eq!(error.code, FileErrorCode::OutsideRoots);
    }
}
