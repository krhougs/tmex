# tmex-cli 发布流程

## 发布内容

`tmex-cli` 的 npm 包源码位于 `packages/app`，发布包包含：

- `dist/cli-node.js`：`tmex` / `tmex-cli` 共用的 CLI 入口；
- `resources/gateway-artifacts`：macOS、Linux 的 arm64/x64 Rust Gateway 产物及 SHA-256 清单；
- `resources/fe-dist`：前端静态资源；
- `CHANGELOG.md`：仅含当前版本的双语更新日志。

Gateway migration 已编译进 Rust binary。npm 包不再包含 JavaScript Gateway、Ghostty WASM 或
运行时 migration 目录。

`packages/app/package.json.version` 与根 `Cargo.toml` 的 `[workspace.package].version` 必须一致。
`bun run release:tmex` 会同时更新二者并刷新 `Cargo.lock`。

## Rust Gateway artifact pipeline

正式四目标产物由 `.github/workflows/tmex-cli-rust-gateway.yml` 在原生 runner 上生成：

| package target | Rust host | runner |
| --- | --- | --- |
| `darwin-arm64` | `aarch64-apple-darwin` | `macos-15` |
| `darwin-x64` | `x86_64-apple-darwin` | `macos-15-intel` |
| `linux-arm64` | `aarch64-unknown-linux-gnu` | `ubuntu-24.04-arm` |
| `linux-x64` | `x86_64-unknown-linux-gnu` | `ubuntu-24.04` |

每个 matrix job 只允许构建当前宿主 target。producer 从 Cargo JSON 的
`compiler-artifact.executable` 读取实际二进制路径，不推测 `target/release` 文件名。每个产物先生成
单 target fragment，再由聚合 job 校验版本、目标完整性和 SHA-256，最终生成 package 直接消费的：

```json
{
  "schemaVersion": 1,
  "version": "0.18.0",
  "artifacts": [
    {
      "target": "darwin-arm64",
      "path": "darwin-arm64/tmex-gateway",
      "sha256": "..."
    }
  ]
}
```

实际清单必须恰好包含四个 target。workflow 使用 GitHub Artifact Attestations 为每个原生 binary、聚合
清单和 npm tarball 生成 Sigstore provenance；这不是 Apple Developer ID code signing 或 notarization，
不得把 provenance 描述成平台签名。

## 标准流程

### 1. bump 版本号并生成 changelog

```bash
bun install
bun run release:tmex <newVersion>
```

脚本会：

1. 生成 `packages/app/CHANGELOG.md` 双语草稿；
2. 更新 `packages/app/package.json.version`；
3. 更新根 `Cargo.toml` 的 Rust workspace version；
4. 通过 `cargo metadata` 刷新 `Cargo.lock`。

可选参数：`--from <ref> --to <ref> --no-bump --date <YYYY-MM-DD>`。

### 2. 改写 changelog

按 [changelog 改写规范](2026061406-release-changelog-flow.md#改写规范agent-步骤) 把草稿改写为
普通用户能理解的英文和简体中文，并删除顶部 `DRAFT` 标记。

### 3. 提交并触发四目标 workflow

将 release 变更提交、推送到允许的上游任务分支，然后在 GitHub Actions 手动运行
`tmex-cli Rust Gateway artifacts`，输入已经提交的 `<newVersion>`。workflow 会依次执行：

1. 四个原生 runner 执行 `cargo build --locked --release`；
2. 对每个二进制生成 provenance attestation；
3. 聚合 schema 1 manifest；
4. 执行 `bun run test:tmex` 和完整 workspace/package build；
5. 用当前 Linux x64 binary 在隔离临时目录执行 `/healthz` smoke；
6. 生成并 attest `tmex-cli` npm tarball。

workflow 不执行 `npm publish`。发布者必须先检查构建、smoke 和 attestation 结果。

### 4. 验证并发布 npm candidate

下载 workflow 的 `tmex-cli-npm-<version>` artifact，并验证 provenance：

```bash
gh attestation verify ./tmex-cli-<version>.tgz -R krhougs/tmex
npm whoami || npm login
```

稳定版：

```bash
npm publish ./tmex-cli-<version>.tgz --access public --tag latest
```

预发布版：

```bash
npm publish ./tmex-cli-<version>.tgz --access public --tag next
```

### 5. 发布后验证

```bash
npm view tmex-cli version
npx --yes tmex-cli@<version> --lang en help
```

必要时再执行安装诊断：

```bash
npx --yes tmex-cli@<version> doctor --lang en
```

## 本机调试 producer

本机命令只构建当前宿主，传入其他 target 会 fail-closed：

```bash
bun scripts/gateway-release-artifacts.ts build \
  --version <version> \
  --out-dir dist/gateway-input
```

从 workflow 下载到同一目录的四个 fragment 可聚合为 package manifest：

```bash
bun scripts/gateway-release-artifacts.ts assemble \
  --input-dir dist/gateway-input \
  --version <version> \
  --out-dir dist/gateway-release
```

完整本地 package build 必须显式提供该 manifest，不存在 JavaScript fallback：

```bash
TMEX_GATEWAY_ARTIFACTS_MANIFEST="$PWD/dist/gateway-release/manifest.json" bun run build
bun run test:tmex
npm pack --dry-run --workspace tmex-cli
```

## 常见错误

- 不要在单台机器伪造四目标构建状态；正式产物只能来自 workflow 的四个原生 runner。
- 不要恢复旧 Bun managed artifact；Rust Gateway producer 是唯一 production Gateway 构建入口。
- 不要跳过 package/Cargo 版本一致性或 SHA-256 校验；producer 和 consumer 都会 fail-closed。
- 不要直接对工作区执行 `npm publish`；发布 workflow 生成并验证过的 `.tgz`。
- `bun run publish:tmex` 只适用于已经显式提供完整
  `TMEX_GATEWAY_ARTIFACTS_MANIFEST` 的受控本地流程，默认不会下载或伪造 release artifact。
