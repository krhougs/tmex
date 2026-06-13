# Prompt 存档：三套环境（development / test / production）env 体系重构

## 第一轮 prompt

> 我们需要按照现代软件发流程确认环境
> 我们需要有development testing production三个环境，环境从NODE_ENV读取
> 在当前开发环境，我们应该维护development.env 和 testing.env 两个环境变量文件，
> 各种测试（包括但不限于e2e和单元测试）走testing
> 开发服务器走development环境
>
> production环境仅限打包后的安装的生产环境运行，你需要测好

## 后续澄清（brainstorming 过程中的关键决策）

- 加载机制问题的回复：
  > 那我们就用test作为环境命名。应用启动时自加载配置（ENV和其他的环境变量都是很重要的，我们现在需要自己维护这些东西了），记得处理好dev脚本

  → 环境命名最终用 `test`（对齐 `bun test` 自动设的 `NODE_ENV=test`），文件为 `development.env` / `test.env`；应用启动时自加载。

- 设计分段确认：文件布局、加载器逻辑、三入口接入逐段「对」。

- 补充要求：
  > 对但是缺细节，新增加的很多变量都还没有在生产测，我们还需要检查生产环境的wrapper和安装脚本

  → 增加对生产 install.ts / writeRunScript / buildAppEnvValues / launchd / upgrade 链路的全面排查，以及全量环境变量消费清单审计。

- production 分支要求：
  > envloader应该有读取到production就去执行自己的特殊逻辑

  → loadEnv 的 production 不是「空早返回」，而是走专属 `applyProductionEnv()`：fail-fast 校验生产契约（必需键齐全、路径键指向真实安装目录）+ 打印生产摘要，绝不读仓库文件、绝不净化路径键。

## 备注

完整设计见同目录 `plan-00.md`。
