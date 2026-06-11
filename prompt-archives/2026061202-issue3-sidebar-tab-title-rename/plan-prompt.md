# Prompt 存档

## 2026-06-12 初始 prompt

> 修复 https://github.com/krhougs/tmex/issues/3 修复方案我写在评论区了

### Issue #3 原文（标题：Bug — Functional）

报告称新建设备/窗口后名称不可编辑，没有任何重命名入口（无双击、无右键菜单、无编辑图标），窗口永远停留在默认名。期望支持 inline rename 或菜单内 Rename，重命名持久化，禁止空名并限制长度。

### krhougs 评论区给出的修复方案（即本任务的需求）

> 不是bug，但是值得一做：
> 1. sidebar tab会和终端页面最上方标题栏显示同样的由终端set的标题
> 2. sidebar允许调节宽度（手机上强制占满宽度）
> 3. sidebar tab内允许多行文字（配合1）
> 4. 支持为tab重命名，这个名字持久化在gateway内存中，需要有同步策略
> 5. 重命名和现有的关闭窗口合并进同一个二级弹出菜单中

## 2026-06-12 后续反馈

> node_env的问题

（确认 e2e 黑屏根因为 shell 继承 NODE_ENV=production，已在 playwright.config.ts 钉死 development）

> 只有active tab才能显示OSC name，不符合预期

（根因：gateway snapshot 的 `list-panes -t <session>` 不带 `-s`，只列活跃窗口的 panes，非活跃窗口 panes 为空 → tab 回落 window.name）

> tab里还是得展示当前进程名字

（tab 显示名改为「进程名: OSC标题」组合，customName 优先；title 缺失或与进程名相同则只显示进程名）

> tab采用两行排版，上面为标题，下面为进程名，颜色和字体大小做一下区分，弱化进程名

（新增 buildWindowTitleParts，tab 上行标题 text-xs font-medium 两行截断，下行进程名 text-[10px] muted 单行；单行场景仍用 buildWindowDisplayName 组合串）

> 进程名放上面

> 标题名字字太大，进程名字太小

（定稿：上行进程名 text-[10.5px] muted 单行，下行标题 text-[11px] font-medium 两行截断）

> 1. 标题行高改小一点点。
> 2. 进程名使用等宽字体
> 3. 标题应该在保证CJK正常断字的情况下，英文按照空格breakline

（标题 leading-snug→leading-tight；进程名加 font-mono；标题 break-all→[overflow-wrap:break-word]，已截图验证中英混排断行）

> 哦标题也要monospace

> 进程名还是放下面

（定稿：上行标题 font-mono text-[11px] medium 两行截断，下行进程名 font-mono text-[10.5px] muted 单行；顺带修复 block 与 line-clamp 的 display 冲突导致截断失效的问题）

> active indicator变成tab的背景颜色
> 手机端确保tab菜单可见，且菜单内部触摸友好

> tab active 的颜色和圆角不明显，得改

（active 圆点移除，window/pane 行 active 态改为 bg-accent + border-border/70 + rounded-lg；触屏下 ⋮ trigger 放大至 h-8 w-8 常显，菜单 min-w-48、菜单项 py-2.5）

> tab 的margin调大一点
> tab菜单在手机上根本没法点
> （澄清）我说的没法点的意思是，按钮太小，隔得太近

（窗口列表 p-1.5 + space-y-1.5（触屏 space-y-2）、行内触屏 py-2.5；⋮ 与 pane × 触屏放大至 40×40（h-10 w-10），行 pr-12 让位；pane 列表 space-y-1）

> 1. tab的二级操作菜单按钮太小，移动端非常不友好
> 2. 视觉上也需要区分一下active device

> active device白边太明显了会抢视觉中心
> active device不要突出白边

（⋮/pane × 增加 isMobile（useSidebar 宽度断点）条件：44×44 + bg-background/40 衬底常显，覆盖 any-pointer:coarse 不生效的场景（窄窗口/部分 WebView）；菜单项 isMobile 下 py-3 text-base；选中设备只用背景区分：容器 bg-card（其余 bg-card/50）+ header bg-primary/10，不加 primary 边框/ring）

> active device的顶端背景颜色不应该和其线框一样
> 太亮太扎眼睛了，想想别的颜色方案

（方案三：header 背景维持 bg-muted/30 不变，选中设备改为 header 左缘 2px `bg-sky-500` 竖条 + 设备图标 `text-sky-400`——注意本主题 primary 接近白色，用 primary 做竖条仍是"白边"）

> 蓝色改成灰色，左边足够区分了

（定稿：左缘竖条 `bg-muted-foreground/70` 灰色，图标恢复 muted 不变色）
