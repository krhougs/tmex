# tmux 进程在 tmex 崩溃/重启时的存活

## 背景

tmex 的设计哲学沿用 tmux：只要业务 tmux 会话还在、用户随时能 attach，tmex 进程本身的崩溃或重启就不应该带走这些会话。tmex 通过 `tmux new-session -d` 创建会话，`-d` 已经让会话以 daemon 形式脱离 tmex 的控制终端运行。但进程是否真正存活，最终由服务管理器在 stop/restart/crash 时的 kill 策略决定——默认策略会把 tmex 派生出的整个进程组（含 tmux）一并杀掉，daemon 化不足以保证存活。

## 改动

服务定义模板按平台分别放宽 kill 范围，使其只针对 tmex 主进程，不波及由它启动的 tmux：

- **Linux（systemd 用户单元）**：`[Service]` 段新增 `KillMode=process`。systemd 在 stop/restart 以及进程异常退出（crash 触发 `Restart=always`）时，只向 MainPID 发送终止信号，不再对整个 unit cgroup 广播。tmux 因此不被连带终止。
- **macOS（launchd）**：plist 新增 `AbandonProcessGroup=true`。launchd 终止 job 时默认会向该 job 进程组里的所有进程广播信号；置为 true 后只终止主进程，放弃对进程组的连带处理，tmux 得以存活。

覆盖范围：两者均覆盖 stop、restart 与 crash 重启场景，即由服务管理器主动终止 tmex 主进程的所有路径。

## 关键边界（Linux）

`KillMode=process` 只约束 per-unit 的 kill 行为，约束不了 user slice 级别的清理。用户级 systemd 默认 `KillUserProcesses=yes`，当用户 logout 或系统 reboot 时，整个 user slice 会被拆除，无视任何 per-unit 的 `KillMode`，把该用户的所有进程（tmex 与 tmux 一起）全部杀光。

要让会话跨 logout/reboot 存活，需用户手动开启 linger：

```
loginctl enable-linger <user>
```

tmex 默认不代为启用 linger，以免擅自改动账户系统状态（linger 会让该用户的 systemd 用户实例常驻、不随登录会话退出而停止，属于账户级配置变更，应由用户知情后自行决定）。

## 生效方式

服务定义（systemd unit / launchd plist）只在安装或升级时重新渲染落盘。已运行的实例不会热更新这些文件，因此本修复需要用户执行 `tmex upgrade` 或重装后才落地。

注意一次性代价：**携带本修复的那一次升级，其自身的 stop/restart 仍按旧策略执行**，会照旧掉一次 tmux；只有在新服务定义落盘并重启之后的崩溃/重启才受保护。

## 平台范围

不涉及 Windows。`detectServiceManager` 在 Windows 上返回 `none`，tmex 不在该平台安装服务，相关 kill 策略不适用。
