# 执行结果（2026-07-27）

> 状态：实施完成，全部 codex 验收通过。tmex 分支 vibex/terminal-ligature-rendering（5 commits）。

## 落地内容

### P1 ghostty 升级（tmex commits `1f2fd0f` + `18eafcd`）

- `vendor/tmex/vendor/ghostty`：43a05dc96（2026-04-15）→ 32e76d8ed（2026-07-26，1.3.2-dev，789 commits）。
- `build-wasm.sh` Zig 0.15.2 → 0.16.0；重建 `ghostty-vt.wasm`（702329 B）+ metadata。
- bindings 核对：53 个硬编码 `GHOSTTY_*` 枚举、59 个 wasm 导出、68 个调用点参数、51 个 C API 原型全部一致（上游 append-only）。
- 验证：`verify:wasm` ✓、ghostty-terminal 109→128 tests ✓、smoke-compiled ✓。
- **codex 独立验收：PASS，零问题**（独立复核了枚举/ABI/参数面）。

### P2 符号宽度约束（tmex commit `b3e9478`）

- 新增 `packages/ghostty-terminal/src/glyph-constraint.ts`（纯函数 `resolveGlyphConstraint` + 8 个单测）。
- `canvas-renderer.ts`：非 ASCII 窄符号（单 codepoint）经 `measureText().actualBoundingBox*` 检测墨迹（按 `font|char` 缓存）；右邻空 cell 放行 ≤2 格溢出（Iosevka 宽符号设计意图），否则等比缩放居中进本格（ghostty `.fit` 等价）。`˄` 型墨迹整体偏右的字形在右邻有字时被平移回本格（scale=1 纯平移，算法自然导出）。

### P3 真连字 + terminalLigatures 设置（tmex commit `51bf2d2`）

- 新增 `packages/ghostty-terminal/src/ligature-segments.ts`（段扫描纯函数 + 11 个单测）：同可比样式（bg 不参与）的连续 ASCII 符号 cell（`!#$%&*+-./:;<=>?@\^_|~`，长度 2–8）合并为段。
- `canvas-renderer.ts`：ligatures 开启时段整体一次 `fillText` 按段首 cell 网格定位（浏览器 shaping 获得上下文触发 calt）；段内 tail cell 只画装饰线；关闭时零开销走原逐 cell 路径。
- 设置链路：`stores/ui.ts` `terminalLigatures`（默认 true，含 partialize）→ 设置面板 Switch（`terminal-ligatures` testid）→ 三语 i18n（`settings.terminal.ligatures[Desc]`）+ build:i18n → Terminal.tsx / TerminalPreview.tsx（含 effect 依赖，变更重建终端）→ `GhosttyTerminalInitOptions.ligatures` → IME textarea `font-variant-ligatures` → fe `--font-mono-ligatures` CSS 变量（`.font-mono, code, pre, kbd, samp`）。

### vibex 侧跟进

- `packages/workspace-runtime/src/host-ui-store.ts`：`terminalLigatures` 字段/默认值/setter/partialize。
- `packages/workspace-ui/src/hooks/use-app-mono-font.ts` + `styles/shared.css` + `styles/product.css`：`--font-mono-ligatures` 同步。
- 测试：workspace-runtime 20 ✓、platform-browser 26 ✓、platform-native 30 ✓、workspace-ui 53/54（1 个 flow-bridges 失败经 stash 对照确认为基线预存在，与本改动无关）。

## 验收证据

- tmex 改动面包全绿：ghostty-terminal 128、terminal-ui 91、panels 8、stores 57（site-theme 全套并发下 flaky、单独跑全绿）；全仓其余失败集中于 ws-client/gateway/app（网络/tmux 环境性，未触碰）。
- **真实 CanvasRenderer 视觉验收**（bun build 渲染器 + 构造 frame + Playwright，见 `acceptance-renderer.png`）：
  - ON：`=> -> != === <!--` 连字生效；`x→y ⇒z a—b` 缩放不重合；`→ ⇒ —` 右邻空格保留双格宽；`p˄q ※s` 回本格。
  - OFF：完全逐字符；符号约束（P2）独立生效。
- 前期研究实证（fontTools/HarfBuzz/Playwright）：Zed Mono 1271 个映射字符墨迹溢出 advance（根因），canvas fillText 触发 calt（Chromium），Iosevka per-cell partial ligature 机制。

## 已知边界与取舍（按最佳实践先行）

- 光标处不断连字段（tmex 光标为独立层底条不反色；ghostty `font-shaping-break=cursor` 语义不适用，实测有异议再补）。
- 字母连字（www、fi/fl）不支持（与 ghostty 坏连字断点方向一致）。
- WebKit 的 canvas calt 触发性未实测（Chromium 已证）；若 WebKit 不触发则连字自动降级为无连字，P2 修复不受影响。
- 段长上限 8：亚像素漂移封顶（Zed/Fira 零漂移、Geist 0.1px/字符），超长符号串按窗口切分。

## codex review 记录

- P1（升级）：**PASS 零问题**——独立复核 53 个枚举常量、59 个 wasm 导出、68 个调用点参数、51 个 C API 原型全部一致。
- P2+P3（约束+连字）首轮：**FAIL，3 项**（其余检查面——绘制状态、脏行交互、缓存键、设置链路、wide/grapheme/selection 边界——均无问题）：
  1. 高：行末宽墨迹放行 2 格会被 canvas 边界裁切（ghostty 行末强制 1 格）；
  2. 中：缺「前邻也是受约束符号则收紧」规则，连续箭头一缩一放尺寸不齐（ghostty constraintWidth 规则 4）；
  3. 低：连字段样式比较未解析默认前景色，显式 RGB 与主题前景相同时误断段。
- 三项全部采纳，整改于 tmex commit `2e3bb4e`（行末强制本格 + prevIsSymbol 收紧（isGraphicsElement 排除拼接类图形元素）+ styleKey 用解析后前景色）；渲染器视觉复验通过（连续箭头尺寸一致、行末箭头不裁切）；ghostty-terminal 129 tests 全绿。
- 整改复验（codex 三点专项）：**PASS 零问题**——行末强制 1 格、spacer 物理列语义不误判、styleKey 解析色含 inverse/default 回落、行尾空白裁剪场景正确。
