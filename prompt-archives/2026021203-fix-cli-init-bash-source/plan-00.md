# 计划：修复 `cli init` 报错 `BASH_SOURCE is not defined`

## 背景与根因
- `packages/app/src/lib/install.ts` 的 `writeRunScript` 使用了 JS 模板字面量生成 `run.sh`。
- 脚本内容中包含 `${BASH_SOURCE[0]}`，被 JS 当作插值表达式解析，执行时触发 `ReferenceError: BASH_SOURCE is not defined`。
- 报错发生于 `init` 流程写入 `run.sh` 阶段，属于运行期致命错误。

## 目标
1. `tmex init` / `tmex-cli init` 不再因 `BASH_SOURCE` 报错。
2. 增加回归测试，锁定该问题不再复发。
3. 完成 `tmex-cli` 相关构建与测试验证。
4. 按 patch 版本发版准备（本次先完成代码与验证）。

## 注意事项
- 保持现有 CLI 参数与对外行为不变。
- 保持脚本由 bash 执行（systemd/launchd 已显式指定 bash）。
- 遵循 TDD：先新增失败测试，再做修复。

## 执行步骤
1. 新增 `writeRunScript` 回归测试，先验证当前实现失败（red）。
2. 将 `writeRunScript` 改为数组拼接脚本文本，避免模板字符串误插值。
3. 将脚本目录计算改为 `dirname "$0"`，移除对 `${BASH_SOURCE[0]}` 的依赖。
4. 运行 `tmex-cli` 定向测试和构建，确认修复生效且无回归。
5. 写入执行结果存档 `plan-00-result.md`。

## 验收标准
- 新增测试在修复前失败、修复后通过。
- `bun run --filter tmex-cli test` 通过。
- `bun run --filter tmex-cli build` 通过。

