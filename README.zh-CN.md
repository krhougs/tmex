<div align="right">
  <a href="./README.md">English</a>
</div>

<div align="center">
  <img src="apps/fe/public/logo.png" width="128" height="128" alt="tmex" />
</div>

<h1 align="center">tmex</h1>

<p align="center">
  为 AI Agent 时代重造的 tmux 终端工作区。<br/>
  让 Agent 长时运行、看屏告警、多设备管理，都能在任意终端完成。
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#核心亮点">核心亮点</a> ·
  <a href="#安装与升级">安装与升级</a> ·
  <a href="#安全">安全</a> ·
  <a href="#常见问题">常见问题</a>
</p>

---

## 快速开始

```bash
npx tmex-cli init
```

安装脚本会自动生成密钥、部署运行文件、注册用户级服务（macOS 用 launchd，Linux 用 systemd）并启动 tmex。打开命令行输出的地址，添加设备即可开始使用。

## 核心亮点

| | | |
|---|---|---|
| **AI 时代的开源方式** | **一键安装，自动升级** | **一个侧边栏管理全部** |
| tmex 在公开协作中持续迭代，每一次设计决策、方案取舍与踩坑记录都保留在 `prompt-archives/` 与 `docs/` 中，工程过程可查阅、可复现。 | `npx tmex-cli init` 自动安装并启动服务。升级可在设置页一键完成，或运行 `npx tmex-cli upgrade`；失败时自动回滚到上一个可用版本。 | 左侧边栏整合设备树、AI Agent 与文件管理。Agent 与当前 tmux pane 绑定，切换 pane 时上下文自动跟随。 |
| **终端 Agent，不止写代码** | **Watch：后台值守哨兵** | **随时随地访问终端** |
| 服务端 AI Agent 可读屏、执行命令、向交互程序发按键、搜索网页与抓取页面。无论是写代码、查日志、重启服务、配置网络设备还是日常排障都能胜任。 | Watch 按规则持续看屏，下载卡住、构建报错、日志出现异常关键字时主动告警。通知通过 Telegram、Webhook 或浏览器推送发出。 | 电脑、平板、手机打开浏览器就能继续工作，安装为独立应用后体验更接近原生 App。手机输入专门打磨：虚拟键盘不打乱终端布局，编辑器模式让你从容编辑长命令。 |
| **Ghostty WASM 终端内核** | **本地与远程设备并排** | **原生 tmux Control Mode** |
| 浏览器端终端由 Ghostty 官方 VT 内核编译为 WebAssembly 提供，不依赖自研 ANSI 解析器，终端语义与原生客户端一致。 | 同一侧边栏管理本地机器与远程 SSH 主机，支持密码、私钥、SSH Agent、SSH Config 认证，设备树支持拖拽排序。 | 基于 tmux Control Mode 构建，pane 输出、窗口生命周期与 bell 通知实时到达。Web UI 可与 iTerm2 等原生 tmux 客户端共用同一份会话。 |

## 安装与升级

```bash
# 交互式安装（推荐）
npx tmex-cli init

# 无交互安装（适用于 CI 或自动化）
npx tmex-cli init --no-interactive \
  --install-dir ~/.local/share/tmex \
  --host 127.0.0.1 \
  --port 9883 \
  --db-path ~/.local/share/tmex/data/tmex.db \
  --autostart true

# 环境诊断
npx tmex-cli doctor

# 升级到最新版本
npx tmex-cli upgrade

# 卸载
npx tmex-cli uninstall
```

安装需要 [Bun](https://bun.sh)。`doctor` 命令会检查环境并报告问题。

## 安全

> **tmex 未内置用户鉴权，请在受信网络内运行，不要直接暴露到公网。**
>
> 如需远程访问，建议通过 [Cloudflare Access](https://www.cloudflare.com/zero-trust/products/access/)、Tailscale 等零信任方案保护。

- 密码与私钥均使用 AES-256-GCM 加密存储。
- Webhook 通知使用 HMAC-SHA256 签名验证。
- Agent 写终端操作默认按动作请求确认，且被绑定到单个 pane。
- `fetch_url` 默认拒绝回环、链路本地与私网地址，防止 SSRF。

## 常见问题

**Q：如何让 Agent 在需要输入时触发通知？**

在项目的 `AGENTS.md` 或系统提示词中指示模型：需要用户交互时显式输出 `\a`（BEL 控制字符）。tmex 会捕获 bell 事件并通过已配置的通知渠道推送。

**Q：Telegram 通知如何配置？**

在设置页添加一个或多个 Telegram Bot，然后审批允许接收告警的聊天。tmex 会在 bell 事件、Agent 确认请求、Watch 触发和出错时发送通知。每个 Bot 可服务多个聊天，你也可以随时撤销授权。

**Q：SSH 主机开启大量 pane 后，为什么部分通知或输出会丢失？**

tmex 为每个 pane 开启独立的远程读取通道。OpenSSH 默认 `MaxSessions=10`，pane 数量较多时会耗尽该限制。请在目标主机的 `sshd_config` 中将 `MaxSessions` 调整为至少 `pane 数量 + 3`，然后重启 sshd。

**Q：为什么 tmex 默认不开启 OSC passthrough？**

默认关闭 passthrough 可避免 pane 内程序将私有终端控制序列直接透传到宿主终端，从而缩小终端逃逸攻击面。如果你明确需要 iTerm2 等宿主终端接收 OSC 序列，可设置环境变量 `TMEX_TMUX_ALLOW_PASSTHROUGH=true`。

## License

MIT
