# Prompt 存档 — 完善更新功能

## 原始 /goal（2026-06-14）

我们来完善更新功能：

1. 纠正 agents.md 中的表述，通过终端执行更新方式应该是 `npx tmex-cli@version upgrade`
2. 设置页面应该有自己的 section 单独展示版本并提供手动更新功能
3. 需要补充一个方式来判断安装方式（是否通过 CLI 安装，部署方式为 launchd 还是 systemd 还是非 CLI 安装）
4. 前端浏览器需要在 console print monorepo 的版本，后端需要在启动时输出 monorepo 版本
5. 2 中检测更新的方法应该是直接通过 npm 查询 tmex-cli 的版本，并展示 changelog，提供确认升级按钮，确认升级按钮会警告用户会中断当前的访问，可能影响 tmux 进程本身的存活。
6. 服务端需要管理唯一的升级状态（下载中，执行中，idle）
7. 升级调用 npx 或其他类似程序需要无视缓存
8. NODE_ENV 不为 production 时显示版本为 monorepoVer_dev，同时禁用程序内更新功能
9. 非 CLI 安装时禁用程序内更新功能

## 后续澄清（AskUserQuestion — changelog 来源）

问：检测更新时展示的 changelog 从哪里取？仓库目前没有 CHANGELOG，发布也是手动 bump 版本。

答：**你需要完善一下发版流程，bump 版本需要增加一个步骤就是读取 commit 生成 changelog。changelog 只包含当前版本的信息。**

→ 即：每次发版读取自上次 release 以来的 commit，生成「仅含当前版本」的 CHANGELOG.md，随包发布；gateway 检查更新时从 CDN 拉取目标版本包内的 CHANGELOG.md 展示，拉取失败回退到 npm registry 的版本号+发布时间列表。
