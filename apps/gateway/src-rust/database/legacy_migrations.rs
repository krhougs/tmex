#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LegacyDrizzleMigration {
    pub idx: usize,
    pub version: &'static str,
    pub when: i64,
    pub tag: &'static str,
    pub hash: &'static str,
    pub sql: &'static str,
    pub statements: &'static [&'static str],
}

include!(concat!(env!("OUT_DIR"), "/legacy_drizzle_migrations.rs"));

#[cfg(test)]
mod tests {
    use super::LEGACY_DRIZZLE_MIGRATIONS;
    use std::fs;
    use std::process::{self, Command};
    use std::time::{SystemTime, UNIX_EPOCH};

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
    const EXPECTED_HASHES: [&str; 18] = [
        "2332605315ff71c3a4eaba6caedd4613ca1a7907afd8ed470b00277fb5b50ca0",
        "301f877df2e6534b106b4d4ca9f2b705e1ee4764779833af0e55831acbc291cd",
        "4e6cf989e7f331139bdbb818a29c434ea9940a0ea3fa235fc2b1ab67242458c7",
        "cf747bade24d247ea66e1cd7c282bb020639328b3800aa849542ebc5844d4566",
        "d5bac100f639eaffc6801cba37a1295638623ff0fd4fc3e48697e538b779a9a3",
        "24bcabeb8408cfdcb647f998d985028b5846f98fc4a7786691ce9d94748583a6",
        "ba4cfa98fca47c772f66c38de7a3c36b14e6ad1e2bc3db98d8f16ecc3905cb7a",
        "42245d94e56973d5e37a112cb9dbaf8be221460be54326206b2c81da7f41c33b",
        "3a7800f0016ced3487685e3c5e7420624269d8da6888de28f5dc43632534b395",
        "dbb0f6fa8f4a9e8f73c23fee34bc0a349ee3aa05debc3ca1349e194e2561b502",
        "de2b0dd0cfdad0bf84fdf685f9ba8d405304f97d25b62060cb9a6030d87750ec",
        "56123d0d536ce504ad46c698f41b02fe6c8230d18930d20571b77bb29f828533",
        "9f079124a3d01dcf8d8ac49ce3140adc32a9cd119f1a1f590afc79932b00f8b4",
        "7075b706ad9ea09dff9d50e921df40164b09bb9e1b8fb4e95128a468e7aad58b",
        "1a5c088eac39c4028a5f4fef29c53758926a39e61aeb21681afb7053b5221c44",
        "82c114acdebd3b001f148c90023cc02c401ce9f556c4e4c99a4d61bb57be17d8",
        "ab25abc85f72ad6702ab89132df63ec174b725f72dd715aa6a0c327b71056ad8",
        "6bdf3c743a12fdef6fa6ff3399c99f700a95866ce18d25412d1f19e63ba98fb6",
    ];

    #[test]
    fn preserves_the_complete_legacy_order_and_hashes() {
        assert_eq!(LEGACY_DRIZZLE_MIGRATIONS.len(), EXPECTED_TAGS.len());

        for (expected_idx, migration) in LEGACY_DRIZZLE_MIGRATIONS.iter().enumerate() {
            assert_eq!(migration.idx, expected_idx);
            assert_eq!(migration.tag, EXPECTED_TAGS[expected_idx]);
            assert_eq!(migration.hash, EXPECTED_HASHES[expected_idx]);
            assert_eq!(migration.version, "6");
            assert_eq!(
                migration.statements.join("--> statement-breakpoint"),
                migration.sql
            );
        }
    }

    #[test]
    fn remains_available_without_runtime_migration_files() {
        const CHILD_MARKER: &str = "TMEX_EMBEDDED_MIGRATION_TEST_CHILD";
        const TEST_NAME: &str =
            "database::legacy_migrations::tests::remains_available_without_runtime_migration_files";

        if std::env::var_os(CHILD_MARKER).is_some() {
            assert_eq!(LEGACY_DRIZZLE_MIGRATIONS.len(), 18);
            assert!(LEGACY_DRIZZLE_MIGRATIONS
                .iter()
                .all(|migration| !migration.sql.is_empty() && !migration.statements.is_empty()));
            return;
        }

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after the Unix epoch")
            .as_nanos();
        let isolated_dir = std::env::temp_dir().join(format!(
            "tmex-gateway-embedded-migrations-{}-{nonce}",
            process::id()
        ));
        fs::create_dir(&isolated_dir).expect("isolated runtime directory should be created");

        let status = Command::new(std::env::current_exe().expect("test executable should exist"))
            .arg("--exact")
            .arg(TEST_NAME)
            .arg("--nocapture")
            .env(CHILD_MARKER, "1")
            .current_dir(&isolated_dir)
            .status()
            .expect("isolated migration test process should start");

        fs::remove_dir(&isolated_dir).expect("isolated runtime directory should remain empty");
        assert!(status.success(), "isolated migration test process failed");
    }
}
