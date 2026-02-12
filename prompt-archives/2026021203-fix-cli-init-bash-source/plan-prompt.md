# Prompt 存档：修复 `cli init` 报错 `BASH_SOURCE is not defined`

## 背景
- 仓库：`/home/krhougs/tmex`
- 现象：已发布的 CLI 执行 `init` 时直接报错：`BASH_SOURCE is not defined`
- 诉求：系统性排查根因，检查潜在问题，并提出修复方案。

## 对话摘录（原始意图）
用户：
1. 现在已经发布 cli init 报错：BASH_SOURCE is not defined  
   请系统性排查问题，并检查潜在问题，提出修复方案
2. Implement the plan.
3. Feb 12 20:08:48 dev systemd[2094]: /home/krhougs/.config/systemd/user/tmex.service:7: WorkingDirectory= path is not absolute: "/home/krhougs/.local/share/tmex"
4. 当然需要（确认继续完善升级链路的服务重写与重启保障）
5. node packages/app/bin/tmex.js --lang zh-CN upgrade --apply-current-package --install-dir /home/krhougs/.local/share/tmex
6. ● tmex.service ... status=127，并反馈“也看不到log”

## 已确认的实现偏好
- 修复策略：整体改为非模板拼接（避免 JS 模板字面量误插值），并把脚本目录定位从 `${BASH_SOURCE[0]}` 改为基于 `$0`。
- 发版策略：Patch 版本发布（例如 `0.1.0` -> `0.1.1`）。
