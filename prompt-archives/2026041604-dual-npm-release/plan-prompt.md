## Prompt 00

- 用户初始要求：`bump版本到0.3.0 然后发npm`。
- 进一步澄清：npm 上这个包应该叫做 `ghostty-terminal`，并且需要同时发布 `ghostty-terminal` 和 `tmex-cli` 两个包。
- 当前已知事实：
  - `packages/ghostty-terminal/package.json` 当前名称仍为 `@tmex/ghostty-terminal`，版本 `0.1.0`。
  - `packages/app/package.json` 对应 `tmex-cli`，当前版本 `0.2.6`。
  - npm registry 上 `ghostty-terminal` 目前不存在；`tmex-cli` 当前线上版本是 `0.2.6`。
  - `npm whoami` 当前返回 401，发布前需要 npm 登录。

## 当前目标

- 将 `packages/ghostty-terminal` 改为可发布的 `ghostty-terminal@0.3.0`。
- 将 `tmex-cli` bump 到 `0.3.0` 并发布。
- 完成发布前校验，并尽可能执行实际发布；若被 npm 登录阻塞，明确阻塞点。
