# 前端 bundle 体积优化（#33 的真正落点）

## Context（背景）

Issue #33 抱怨弱网下前端加载慢/白屏。用户明确：**压缩（gzip/br）是无所谓的事，要优化的是包体积本身**。

实测现状（main，`apps/fe/dist`）：
- **首屏**：`index-*.js` **1.245 MB**（raw）+ `index-*.css` 136 KB。这是弱网真正等待的东西。
- **已妥当懒加载、不进首屏**（无需动）：mermaid.core 606KB + wardley 601KB + cytoscape 433KB（`mermaid-block.tsx:16` 动态 `import('mermaid')`，按图表类型自动拆 chunk）、markdown-preview 444KB（FilePage/SettingsPage 路由懒加载）、ghostty-vt.wasm 542KB（DevicePage 路由懒加载）。各 Page 已 `import()` 路由级拆分。
- **`.map` 文件占 18 MB**（`vite.config` 的 `sourcemap: true`）——这是 #33 所谓“24MB fe-dist”的主体，随 `resources/fe-dist` 分发（普通用户不下载，但占安装/升级包）。

探查澄清两条 agent 的不可靠猜测：
- **lucide-react 不是问题**：全部 named import（`app-sidebar.tsx:1` 等），esbuild 已摇树，仅 ~35 个用到的图标进 bundle。**不要**替换图标库（除非 visualizer 实测证明大）。
- **react-query 双版本（5.90/5.99）**是跨 workspace 的，FE bundle 只含自己解析到的那一份；对首屏基本无收益，仅是 hygiene。

→ 真正可削的首屏“浪费”：**i18n 把 3 种语言全打进首屏**（实测 132KB raw / 36KB gz，只需 1 种）+ **sidebar 的 AgentTab/FilesTab 静态 import 进首屏**（虽条件渲染）。其余是框架本身（React/router/query/zustand），不可压缩。

## 目标
按「实测收益 × 是否首屏 × 成本」削减体积，优先首屏下载。**不碰压缩**。

---

## 改动（推荐方案，按优先级）

### 0. 先加 bundle 可视化做基线（“检查 vite”的交付物）
- `apps/fe` 加 `rollup-plugin-visualizer`，用 `ANALYZE=1`/新增 `build:analyze` 脚本门控（不影响正常 build）。`vite.config.ts` 的 `plugins` 里条件 push。
- 产出 treemap，**用真实数字替换 agent 的估算**，量化下面每步的前后差，并兜底排查意外大模块。基线：`index-*.js` 1.245MB。

### 1. i18n 只加载当前语言（首屏最大可削项，实测 -88KB raw / -24KB gz）
现状：`apps/fe/src/i18n/index.ts` 静态 `import { I18N_RESOURCES }`（en_US+zh_CN+ja_JP 全量）。但 **gateway 也用 `I18N_RESOURCES`**（`apps/gateway/src/i18n/index.ts`，经 `@tmex/shared` re-export），且语言可运行时切换（`stores/site.ts` / `SettingsPage.tsx` 调 `i18n.changeLanguage(settings.language)`）。

方案（**复用现有 `packages/shared/src/i18n/locales/*.json`，不改 build-i18n 生成器、不动 gateway 聚合导出**）：
- `vite.config.ts` 加 alias，如 `@i18n-locales` → `packages/shared/src/i18n/locales`。
- `apps/fe/src/i18n/index.ts` 改用 `i18next-resources-to-backend`（轻量；或手写等效 backend 免依赖），loader = `(lng) => import(`@i18n-locales/${lng}.json`).then(m => m.default.translation)`（JSON 顶层是 `{ translation: {...} }`，见生成器 `generateTypes` 读 `firstLocale.translation`）。Vite 按 locale 自动拆 chunk，只取当前语言；`changeLanguage` 切到未加载语言时 backend 自动按需拉取。
- 初始语言仍走 `detectBrowserLocale()`；`fallbackLng` 设为加载到的语言（各 locale 由同一套 key 生成、视为完整，不跨语言回退）。**bootstrap 改异步**：`i18n/index.ts` 导出 init promise，`main.tsx` 渲染前 `await`（多一个 ~12KB gz 的小 chunk RTT，换 index.js 直接瘦 24KB gz——弱网净赚）。
- gateway 与 `@tmex/shared` 的 `I18N_RESOURCES` **保持不变**（服务端继续全量）。
- 风险点：Vite 对 alias+模板字面量动态 import 的解析；若有问题退回 `import.meta.glob('@i18n-locales/*.json')` 显式映射。

### 2. sidebar AgentTab / FilesTab 改 React.lazy（defer agent+files 子系统出首屏）
`apps/fe/src/components/page-layouts/components/app-sidebar.tsx:5-6` 静态 import、`:72-73` 才条件渲染（默认 tab 是 `panes` 的 `SideBarDeviceList`，保持 eager）。
- 改：`const AgentTab = lazy(() => import('@/components/agent-panel/agent-tab').then(m => ({ default: m.AgentTab })))`，FilesTab 同理（二者是 named export，需 `.then` 包装）。
- `:70-74` 的 `SidebarContent` 内 `{sidebarTab==='agent' && <AgentTab/>}` 用 `<Suspense fallback={…轻量 spinner…}>` 包住。
- 收益：把 agent store（~1160 行）+ ChatThread/ModelPicker 链、files 子系统 + react-query file hooks 从首屏移到点对应 tab 时加载。**实际 KB 由 step 0 visualizer 确认**。

### 3. highlight.js 限定语言（markdown-preview 懒 chunk，非首屏）
`apps/fe/src/components/markdown/markdown-preview.tsx:3` 用 `rehype-highlight`（→ lowlight/highlight.js）。先确认其版本默认集（v7 默认 `common` ~37 种，非 190）；给 `rehypeHighlight` 传 curated `languages`（js/ts/py/bash/json/yaml/sql/md/rust 等常用十几种），其余不注册。削 markdown-preview(444KB) 这条懒加载链，FilePage/SettingsPage 打开更快。收益 step 0 量化。

### 4. 生产构建关 sourcemap（削 fe-dist 18MB 分发体积）
`vite.config.ts:60` `sourcemap: true` → 改为按 flag：发布/`isProd` 构建默认 `false`，本地 debug 可经 env 开。去掉 18MB `.map`（#33“24MB”的主体）。**不改首屏 .js 下载**，纯削安装/升级包。属可逆决策（牺牲线上 source map 调试）——若要保留排障能力可改 `'hidden'`，但那样文件仍在盘上不减体积；本计划默认 release 不出 map。

### 明确不做（避免无用功）
- **不**替换 lucide / 手搓 SVG（已摇树）。
- **不**为体积去 dedupe react-query（首屏无收益）；若 step 0 treemap 真显示 FE bundle 含两份，再加根 `overrides`。
- `manualChunks` 仅利缓存非利体积，可选、低优先。

## 关键文件
- 改：`apps/fe/vite.config.ts`（visualizer 插件 + `@i18n-locales` alias + sourcemap flag）
- 改：`apps/fe/src/i18n/index.ts`（异步 backend、按需 locale、导出 ready promise）+ `apps/fe/src/main.tsx`（渲染前 await）
- 改：`apps/fe/src/components/page-layouts/components/app-sidebar.tsx`（AgentTab/FilesTab lazy + Suspense）
- 改：`apps/fe/src/components/markdown/markdown-preview.tsx`（rehype-highlight 限定语言）
- 改：`apps/fe/package.json`（devDep `rollup-plugin-visualizer`；如用 backend 加 `i18next-resources-to-backend`）+ `build:analyze` 脚本
- 复用不改：`packages/shared/scripts/build-i18n.ts`、`packages/shared/src/i18n/resources.ts`（生成物，勿手改）、`apps/gateway/src/i18n/index.ts`、现有 `locales/*.json`

## 验收
1. `bun run build:fe` 通过；`ANALYZE=1` treemap 对比前后，记录 `index-*.js` 从 1.245MB 降到多少（raw + gz）。逐项确认：i18n 仅 1 个 locale chunk 进首屏、AgentTab/FilesTab 不在 index、markdown-preview chunk 变小、release 无 `.map`。
2. `bun test apps/fe/src` 全过。
3. 仓内临时实例（按 AGENTS.md，端口/env 显式覆盖，**禁碰生产 9883**）smoke：
   - 默认语言正常渲染、无 missing-key（raw key 不外露）；Settings 切换语言能即时生效（按需拉到新 locale chunk，网络面板可见）。
   - sidebar 切到 Agent/Files tab 内容正常（lazy + Suspense 无闪错）；默认 Panes 不受影响。
   - 打开一个含代码块/公式/mermaid 的 markdown（FilePage）渲染正常。
   - 按个人记忆“视觉改动自己验收”，无头浏览器对首屏 + 各 tab 截图留证。
4. 关键回归守卫：i18n 改成异步后，确认首屏不出现未翻译闪烁（await init 生效）；`changeLanguage` 切到未加载语言不报错。

## 风险
- i18n 异步化引入「渲染前 await locale」一个 RTT；弱网下用 index.js 瘦身（-24KB gz）抵偿，但需确认不退化首屏。Vite 动态 import(alias+模板) 解析失败则退 `import.meta.glob`。
- AgentTab/FilesTab lazy 后，切 tab 有一次 chunk 加载延迟（Suspense fallback 兜住）。
- 关 sourcemap 牺牲线上 source map 调试（可逆）。
- 不改 `build-i18n` 生成器与 `resources.ts`，避免与“勿 lint/改生成文件”冲突；gateway 全量 i18n 不受影响。
- 所有“预计收益”以 step 0 visualizer 实测为准，不照搬 agent 估算。
