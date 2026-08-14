# tmex-cli

Node.js-compatible CLI for initializing, diagnosing, upgrading, and uninstalling tmex deployment.
The installed service executes the packaged native `tmex-gateway` binary; Bun is not required at
runtime.

Use from npm:
- `npx tmex-cli init`
- `npx tmex-cli doctor`
- `npx tmex-cli upgrade`
- `npx tmex-cli uninstall`

Commands:
- `tmex init`
- `tmex doctor`
- `tmex upgrade`
- `tmex uninstall`

Use `--lang en` or `--lang zh-CN` to switch CLI language.

## Release artifact input

Package builds consume prebuilt Rust binaries through `TMEX_GATEWAY_ARTIFACTS_MANIFEST`. The
manifest must use schema version 1, match the `tmex-cli` package version, include exactly one
SHA-256-pinned entry for each supported target (`darwin-arm64`, `darwin-x64`, `linux-arm64`, and
`linux-x64`), and keep every referenced file below the manifest directory. The package build does
not compile or fall back to the legacy JavaScript Gateway. Platform signing remains the release
artifact producer's responsibility; the package verifies and preserves the declared bytes.

```json
{
  "schemaVersion": 1,
  "version": "0.17.0",
  "artifacts": [
    { "target": "darwin-arm64", "path": "artifacts/macos-arm64", "sha256": "..." }
  ]
}
```

The abbreviated entry above illustrates the shape; a build requires all four targets. From the
workspace root, consume the release manifest with:

```sh
TMEX_GATEWAY_ARTIFACTS_MANIFEST=/absolute/path/to/manifest.json \
  bun run --filter tmex-cli build
```
