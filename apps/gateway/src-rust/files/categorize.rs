use super::FileCategory;

pub const MAX_ENTRIES: usize = 2_000;
pub const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;

const MARKDOWN_EXTS: &[&str] = &["md", "markdown", "mdx"];
const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif",
];
const ARCHIVE_EXTS: &[&str] = &["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "zst"];
const AUDIO_EXTS: &[&str] = &["mp3", "wav", "ogg", "flac", "m4a", "aac"];
const VIDEO_EXTS: &[&str] = &["mp4", "webm", "mkv", "mov", "avi", "m4v"];
const TEXT_EXTS: &[&str] = &["txt", "text", "log", "csv", "tsv", "rtf"];
const CODE_EXTS: &[&str] = &[
    "ts",
    "tsx",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "json",
    "jsonc",
    "json5",
    "css",
    "scss",
    "sass",
    "less",
    "html",
    "htm",
    "xml",
    "vue",
    "svelte",
    "astro",
    "py",
    "pyi",
    "rb",
    "go",
    "rs",
    "java",
    "kt",
    "kts",
    "c",
    "h",
    "cpp",
    "cc",
    "cxx",
    "hpp",
    "hh",
    "cs",
    "php",
    "swift",
    "m",
    "mm",
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "bat",
    "cmd",
    "sql",
    "toml",
    "yaml",
    "yml",
    "ini",
    "cfg",
    "conf",
    "env",
    "properties",
    "gradle",
    "lua",
    "r",
    "dart",
    "scala",
    "clj",
    "cljs",
    "ex",
    "exs",
    "erl",
    "hs",
    "ml",
    "mli",
    "pl",
    "pm",
    "vim",
    "lock",
    "tf",
    "tfvars",
    "proto",
    "graphql",
    "gql",
    "prisma",
    "dockerfile",
    "makefile",
    "cmake",
    "nix",
    "zig",
    "d",
    "jl",
    "groovy",
    "patch",
    "diff",
];
const KNOWN_NOEXT: &[&str] = &[
    "makefile",
    "dockerfile",
    "license",
    "readme",
    "changelog",
    "authors",
    "copying",
    "notice",
    "procfile",
    "gemfile",
    "rakefile",
    "brewfile",
    "caddyfile",
    ".gitignore",
    ".gitattributes",
    ".gitmodules",
    ".env",
    ".editorconfig",
    ".npmrc",
    ".nvmrc",
    ".prettierrc",
    ".eslintrc",
    ".babelrc",
    ".dockerignore",
    ".zshrc",
    ".bashrc",
    ".profile",
];

fn extension(name: &str) -> &str {
    match name.rfind('.') {
        Some(index) if index > 0 => &name[index + 1..],
        _ => "",
    }
}

pub fn categorize(name: &str) -> FileCategory {
    let lower = name.to_lowercase();
    let extension = extension(&lower);
    if MARKDOWN_EXTS.contains(&extension) {
        FileCategory::Markdown
    } else if IMAGE_EXTS.contains(&extension) {
        FileCategory::Image
    } else if extension == "pdf" {
        FileCategory::Pdf
    } else if ARCHIVE_EXTS.contains(&extension) {
        FileCategory::Archive
    } else if AUDIO_EXTS.contains(&extension) {
        FileCategory::Audio
    } else if VIDEO_EXTS.contains(&extension) {
        FileCategory::Video
    } else if CODE_EXTS.contains(&extension) {
        FileCategory::Code
    } else if TEXT_EXTS.contains(&extension) {
        FileCategory::Text
    } else if extension.is_empty() && KNOWN_NOEXT.contains(&lower.as_str()) {
        FileCategory::Code
    } else {
        FileCategory::Other
    }
}

pub fn mime_of(name: &str) -> Option<&'static str> {
    match extension(&name.to_lowercase()) {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "svg" => Some("image/svg+xml"),
        "avif" => Some("image/avif"),
        "pdf" => Some("application/pdf"),
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        "ogg" => Some("audio/ogg"),
        "flac" => Some("audio/flac"),
        "m4a" => Some("audio/mp4"),
        "aac" => Some("audio/aac"),
        "mp4" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "mkv" => Some("video/x-matroska"),
        "mov" => Some("video/quicktime"),
        "zip" => Some("application/zip"),
        "gz" => Some("application/gzip"),
        "tar" => Some("application/x-tar"),
        "json" => Some("application/json; charset=utf-8"),
        "txt" => Some("text/plain; charset=utf-8"),
        _ => None,
    }
}
