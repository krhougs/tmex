# Prompt 存档

任务：终端连字渲染 + 符号宽度约束 + ghostty 升级（实施档）。

需求来源（转述）：
1. Zed Mono 等 Iosevka 系字体下，`→ ⇒ — ˄ ※` 等宽墨迹符号在 canvas 终端里溢出相邻 cell，造成"多余空格、文字重合"；
2. 编程连字（`=> -> !=` 等）在逐 cell 渲染下从未生效，需要真实支持并提供设置开关（默认开、可关）；
3. 顺带把 vendor/ghostty 升级到上游最新。

完整背景、根因实证（fontTools/HarfBuzz/Playwright 实验数据）、方案取舍见 plan-00.md。
