# Prompt Archive

## 用户原始需求

我现在需要为当前项目创建一个小白也会用的部署方式，最终呈现方式为：
- 程序跑在当前用户下，不使用任何外部容器
- 支持macOS和apt/yum系的发行版，其他环境不保证能用，但是不会去阻止用户安装
- 用户运行 npx tmex init 后，会启动一个交互式设置程序，设置基本的运行目录、端口、host、数据库位置，是否开机启动，然后生成加密key，生成app.env，生成并安装systemd service
- 用户运行 npx tmex init --no-interactive 则通过参数完成设置
- 用户运行 npx tmex doctor，进行基本的依赖检查和env检查

为了实现上面的功能，我们创建一个新的包`app`，这个包直接引用gateway的核心逻辑，暴露提供一个标准的http服务器，在构建时直接将fe的dist打包进app中。这个包在npm上就叫做`tmex`

我们需要一个构建脚本方便后续的自动化。

## 需求补充与确认

- 增加命令：`npx tmex uninstall`
- macOS 开机启动使用 launchd
- `init --no-interactive` 缺关键参数即报错
- 服务形态采用单端口一体化
- `uninstall` 默认交互确认，同时提供自动化选项
- 增加命令：`npx tmex upgrade`
- `upgrade` 默认原地升级并保留配置/数据
- 必须要求目标机安装 Bun，并检测 Bun 版本；未安装或版本不满足时直接报错退出
- `npx tmex` CLI 必须完全兼容 Node.js
- 部署方式安装的 tmex 不需要应用内生命周期循环；进程退出后由 systemd/launchd 负责重启

## 执行指令

Implement the plan.
