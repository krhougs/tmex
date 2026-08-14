# Result

- `useIsMobile` now accepts an optional desktop media query while retaining `(min-width: 48rem)` as the default.
- `SidebarProvider` forwards its optional `desktopMediaQuery` to the hook, so applications can opt into an orientation-aware persistent sidebar without changing tmex defaults.
- Validation: `bun run --cwd vendor/tmex --filter @tmex/ui test` passed with 11 tests.
- Commit `fadfe69` was pushed to `vibex/native-layout-safe-area`; this result archive is recorded in the follow-up commit on the same branch.
