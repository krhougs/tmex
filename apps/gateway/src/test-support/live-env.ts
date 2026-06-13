// 实测（live integration）凭证守卫。
//
// 实测打真实 endpoint，凭证只放仓库根 test.env.local（已 gitignore），由
// test-preload.ts 的 loadEnv() 在 NODE_ENV=test 下注入 process.env。
//
// 在 *.integration.ts 的「模块顶层」调用本守卫：缺凭证时打印清晰指引并
// process.exit(1) 直接退出——在任何 test 跑之前中止，避免退化成「测试 fail」的
// 误导性断言失败。这样「没填凭证」与「功能真的坏了」泾渭分明。

export function requireLiveEnv(keys: readonly string[], hint: string): Record<string, string> {
  const values: Record<string, string> = {};
  const missing: string[] = [];

  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      values[key] = value;
    } else {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    console.error(
      `\n[live-test] 缺少实测所需的环境变量：${missing.join('、')}。\n` +
        `请在仓库根 test.env.local（已 gitignore）中填写后重试。${hint}\n` +
        '实测打真实 endpoint，缺失凭证属配置问题（报错退出），并非产品缺陷。\n'
    );
    process.exit(1);
  }

  return values;
}

// 「至少提供一个」版本：返回已配置的键子集；一个都没配才报错退出。
// 用于搜索这类「Tavily / Brave 任选其一」的场景。
export function requireAnyLiveEnv(keys: readonly string[], hint: string): Record<string, string> {
  const present: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      present[key] = value;
    }
  }

  if (Object.keys(present).length === 0) {
    console.error(
      `\n[live-test] 需至少提供其中一个环境变量：${keys.join(' / ')}。\n` +
        `请在仓库根 test.env.local（已 gitignore）中填写其一后重试。${hint}\n` +
        '实测打真实 endpoint，缺失凭证属配置问题（报错退出），并非产品缺陷。\n'
    );
    process.exit(1);
  }

  return present;
}
