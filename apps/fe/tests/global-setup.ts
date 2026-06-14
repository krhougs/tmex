import type { FullConfig } from '@playwright/test';

// 与 playwright.config.ts 的 DEFAULT_GATEWAY_PORT 同步；实际运行由 scripts/run-e2e.ts
// 注入 TMEX_E2E_GATEWAY_PORT。
const DEFAULT_GATEWAY_PORT = 9665;

// 兜底防线：webServer 启动早于 globalSetup（Playwright 保证），此处在任何用例运行前
// 直接探测被测 gateway 的 healthz，断言它是 NODE_ENV=test 实例。一旦误连到生产 tmex
// （9883，旧版 healthz 无 env 字段或为 production），立即抛错中止整轮，避免改坏生产数据。
export default async function globalSetup(_config: FullConfig): Promise<void> {
  const gatewayPort = Number(process.env.TMEX_E2E_GATEWAY_PORT) || DEFAULT_GATEWAY_PORT;
  const url = `http://localhost:${gatewayPort}/healthz`;

  let body: { status?: string; env?: string };
  try {
    const res = await fetch(url);
    body = (await res.json()) as { status?: string; env?: string };
  } catch (error) {
    throw new Error(
      `[e2e:globalSetup] 无法连接被测 gateway healthz (${url})：${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (body.env !== 'test') {
    throw new Error(
      `[e2e:globalSetup] 拒绝运行：gateway ${url} 的 NODE_ENV=${
        body.env ?? '(缺失，疑似旧版或生产实例)'
      }，期望 'test'。这可能是生产 tmex（9883）。请用 \`bun run test:e2e\`，或显式设置 TMEX_E2E_GATEWAY_PORT / TMEX_E2E_FE_PORT。`
    );
  }
}
