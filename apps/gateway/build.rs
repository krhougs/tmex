use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::env;
use std::error::Error;
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const STATEMENT_BREAKPOINT: &str = "--> statement-breakpoint";
const EXPECTED_TAGS: [&str; 18] = [
    "0000_busy_starjammers",
    "0001_lowly_the_twelve",
    "0002_broad_vengeance",
    "0003_glamorous_lizard",
    "0004_smiling_layla_miller",
    "0005_fancy_boom_boom",
    "0006_bitter_bushwacker",
    "0007_fearless_pestilence",
    "0008_perfect_ozymandias",
    "0009_lying_lethal_legion",
    "0010_lucky_kabuki",
    "0011_stormy_sauron",
    "0012_naive_lizard",
    "0013_bored_blindfold",
    "0014_lucky_killraven",
    "0015_wise_mongu",
    "0016_cheerful_scarecrow",
    "0017_fixed_greymalkin",
];

#[derive(Deserialize)]
struct Journal {
    version: String,
    dialect: String,
    entries: Vec<JournalEntry>,
}

#[derive(Deserialize)]
struct JournalEntry {
    idx: usize,
    version: String,
    when: i64,
    tag: String,
    breakpoints: bool,
}

struct EmbeddedMigration {
    idx: usize,
    version: String,
    when: i64,
    tag: String,
    hash: String,
    sql: String,
    statements: Vec<String>,
}

fn main() -> Result<(), Box<dyn Error>> {
    let manifest_dir = required_path("CARGO_MANIFEST_DIR")?;
    let drizzle_dir = manifest_dir.join("drizzle");
    let journal_path = drizzle_dir.join("meta/_journal.json");

    println!("cargo:rerun-if-changed={}", journal_path.display());

    let journal_source = fs::read_to_string(&journal_path).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("failed to read {}: {error}", journal_path.display()),
        )
    })?;
    let journal: Journal = serde_json::from_str(&journal_source).map_err(|error| {
        invalid_data(format!(
            "failed to parse {}: {error}",
            journal_path.display()
        ))
    })?;
    let migrations = load_migrations(&drizzle_dir, journal)?;
    let generated = render_migrations(&migrations)?;

    let output_path = required_path("OUT_DIR")?.join("legacy_drizzle_migrations.rs");
    fs::write(&output_path, generated).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("failed to write {}: {error}", output_path.display()),
        )
    })?;

    Ok(())
}

fn required_path(name: &str) -> Result<PathBuf, io::Error> {
    env::var_os(name)
        .map(PathBuf::from)
        .ok_or_else(|| invalid_data(format!("Cargo did not set {name}")))
}

fn load_migrations(
    drizzle_dir: &Path,
    journal: Journal,
) -> Result<Vec<EmbeddedMigration>, Box<dyn Error>> {
    if journal.version != "7" {
        return Err(invalid_data(format!(
            "unsupported Drizzle journal version {:?}; expected \"7\"",
            journal.version
        ))
        .into());
    }
    if journal.dialect != "sqlite" {
        return Err(invalid_data(format!(
            "unsupported Drizzle journal dialect {:?}; expected \"sqlite\"",
            journal.dialect
        ))
        .into());
    }
    if journal.entries.len() != EXPECTED_TAGS.len() {
        return Err(invalid_data(format!(
            "legacy Drizzle journal has {} entries; expected exactly {}",
            journal.entries.len(),
            EXPECTED_TAGS.len()
        ))
        .into());
    }

    let mut seen_tags = HashSet::with_capacity(EXPECTED_TAGS.len());
    let mut migrations = Vec::with_capacity(EXPECTED_TAGS.len());
    let mut previous_when = None;

    for (expected_idx, entry) in journal.entries.into_iter().enumerate() {
        if entry.idx != expected_idx {
            return Err(invalid_data(format!(
                "legacy Drizzle journal entry {expected_idx} has idx {}; expected {expected_idx}",
                entry.idx
            ))
            .into());
        }
        if !seen_tags.insert(entry.tag.clone()) {
            return Err(invalid_data(format!(
                "legacy Drizzle journal contains duplicate tag {:?}",
                entry.tag
            ))
            .into());
        }

        let expected_tag = EXPECTED_TAGS[expected_idx];
        if entry.tag != expected_tag {
            return Err(invalid_data(format!(
                "legacy Drizzle journal entry {expected_idx} has tag {:?}; expected {:?}",
                entry.tag, expected_tag
            ))
            .into());
        }
        if !entry.breakpoints {
            return Err(invalid_data(format!(
                "legacy Drizzle journal entry {:?} disables statement breakpoints",
                entry.tag
            ))
            .into());
        }
        if entry.version != "6" {
            return Err(invalid_data(format!(
                "legacy Drizzle journal entry {:?} has version {:?}; expected \"6\"",
                entry.tag, entry.version
            ))
            .into());
        }
        if previous_when.is_some_and(|previous| entry.when <= previous) {
            return Err(invalid_data(format!(
                "legacy Drizzle journal entry {:?} has non-increasing when {}",
                entry.tag, entry.when
            ))
            .into());
        }
        previous_when = Some(entry.when);

        let sql_path = drizzle_dir.join(format!("{}.sql", entry.tag));
        println!("cargo:rerun-if-changed={}", sql_path.display());
        if !sql_path.is_file() {
            return Err(invalid_data(format!(
                "legacy Drizzle migration file is missing: {}",
                sql_path.display()
            ))
            .into());
        }

        let sql_bytes = fs::read(&sql_path).map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("failed to read {}: {error}", sql_path.display()),
            )
        })?;
        let hash = sha256_hex(&sql_bytes);
        let sql = String::from_utf8(sql_bytes).map_err(|error| {
            invalid_data(format!(
                "legacy Drizzle migration {} is not UTF-8: {error}",
                sql_path.display()
            ))
        })?;
        let statements = sql.split(STATEMENT_BREAKPOINT).map(str::to_owned).collect();

        migrations.push(EmbeddedMigration {
            idx: entry.idx,
            version: entry.version,
            when: entry.when,
            tag: entry.tag,
            hash,
            sql,
            statements,
        });
    }

    Ok(migrations)
}

fn sha256_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn render_migrations(migrations: &[EmbeddedMigration]) -> Result<String, std::fmt::Error> {
    let mut output = String::new();
    output.push_str("pub static LEGACY_DRIZZLE_MIGRATIONS: &[LegacyDrizzleMigration] = &[\n");

    for migration in migrations {
        output.push_str("    LegacyDrizzleMigration {\n");
        writeln!(output, "        idx: {},", migration.idx)?;
        writeln!(
            output,
            "        version: {},",
            rust_string_literal(&migration.version)
        )?;
        writeln!(output, "        when: {},", migration.when)?;
        writeln!(
            output,
            "        tag: {},",
            rust_string_literal(&migration.tag)
        )?;
        writeln!(
            output,
            "        hash: {},",
            rust_string_literal(&migration.hash)
        )?;
        writeln!(
            output,
            "        sql: {},",
            rust_string_literal(&migration.sql)
        )?;
        output.push_str("        statements: &[\n");
        for statement in &migration.statements {
            writeln!(output, "            {},", rust_string_literal(statement))?;
        }
        output.push_str("        ],\n");
        output.push_str("    },\n");
    }

    output.push_str("];\n");
    Ok(output)
}

fn rust_string_literal(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            '\0' => output.push_str("\\0"),
            character if character.is_control() => output.extend(character.escape_unicode()),
            character => output.push(character),
        }
    }
    output.push('"');
    output
}

fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}
