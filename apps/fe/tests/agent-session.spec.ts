// Agent 会话端到端：mock OpenAI server 注册为 provider，
// 覆盖 创建/发消息流式上屏/重命名/删除/provider 不可达 error banner。

import { type Server, createServer } from 'node:http';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { ensureCleanSession, tmux } from './helpers/tmux';

const REPLY_TEXT = 'Hello from mock e2e agent reply';
const MOCK_TITLE = 'Mock Session Title';
const TOOL_DONE_REPLY = 'Tool finished mock follow-up reply';

interface MockLlmServer {
  server: Server;
  port: number;
  baseUrl: string;
}

function sseChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  const chunk = {
    id: 'chatcmpl-e2e',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function startMockLlmServer(): Promise<MockLlmServer> {
  const server = createServer((req, res) => {
    const url = req.url ?? '';

    if (req.method === 'GET' && url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
      return;
    }

    if (req.method === 'POST' && url.startsWith('/v1/chat/completions')) {
      let body = '';
      req.on('data', (piece) => {
        body += piece;
      });
      req.on('end', () => {
        let parsed: {
          stream?: boolean;
          messages?: Array<{ role?: string; content?: unknown }>;
        } = {};
        try {
          parsed = JSON.parse(body) as typeof parsed;
        } catch {
          // 按非流式处理
        }
        const stream = Boolean(parsed.stream);

        if (stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          });

          // 用户消息以 RUN_COMMAND 开头时返回 send_input tool call（needsApproval 走确认流），
          // 续跑请求（messages 中已有 role=tool）则返回收尾文本
          const messages = parsed.messages ?? [];
          let lastUserIndex = -1;
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i]?.role === 'user') {
              lastUserIndex = i;
              break;
            }
          }
          const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;
          // 只看本轮（最后一条 user 消息之后）是否已有 tool 结果，历史轮次的 tool 消息不算
          const hasToolMessage = messages.slice(lastUserIndex + 1).some((m) => m.role === 'tool');
          const lastUserText =
            typeof lastUser?.content === 'string'
              ? lastUser.content
              : JSON.stringify(lastUser?.content ?? '');
          const commandMatch = lastUserText.match(/RUN_COMMAND ([A-Za-z0-9_ -]+)/);

          if (commandMatch && !hasToolMessage) {
            res.write(
              sseChunk({
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: `call_e2e_${Math.random().toString(36).slice(2, 10)}`,
                    type: 'function',
                    function: {
                      name: 'send_input',
                      arguments: JSON.stringify({ text: commandMatch[1], keys: ['enter'] }),
                    },
                  },
                ],
              })
            );
            res.write(sseChunk({}, 'tool_calls'));
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          const replyText = commandMatch && hasToolMessage ? TOOL_DONE_REPLY : REPLY_TEXT;
          res.write(sseChunk({ role: 'assistant', content: '' }));
          for (const word of replyText.split(' ')) {
            res.write(sseChunk({ content: `${word} ` }));
          }
          res.write(sseChunk({}, 'stop'));
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        // 非流式：标题自动生成走 generateText
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-e2e-title',
            object: 'chat.completion',
            created: 1700000000,
            model: 'mock-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: MOCK_TITLE },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

async function createProviderAndSetDefault(
  request: APIRequestContext,
  baseUrl: string,
  name: string
): Promise<string> {
  const providerRes = await request.post('/api/llm/providers', {
    data: { name, protocol: 'openai-chat', baseUrl, apiKey: 'e2e-mock-key' },
  });
  expect(providerRes.ok()).toBeTruthy();
  const created = (await providerRes.json()) as { provider: { id: string } };

  const settingsRes = await request.patch('/api/llm/settings', {
    data: { defaultProviderId: created.provider.id, defaultModelId: 'mock-model' },
  });
  expect(settingsRes.ok()).toBeTruthy();
  return created.provider.id;
}

test.describe
  .serial('agent session', () => {
    let mock: MockLlmServer;
    let providerId: string;
    let deadProviderId: string | undefined;
    let originalDefaults: {
      defaultProviderId: string | null;
      defaultModelId: string | null;
    } | null = null;
    let deviceId: string;
    let windowId: string;
    let paneId: string;
    const sessionName = `tmex-e2e-agent-${Date.now()}`;

    test.beforeAll(async ({ request }) => {
      // 记录测试前的默认 LLM settings，afterAll 复原，避免 reuseExistingServer 本地复用时污染
      const settingsRes = await request.get('/api/llm/settings');
      if (settingsRes.ok()) {
        const payload = (await settingsRes.json()) as {
          settings: { defaultProviderId: string | null; defaultModelId: string | null };
        };
        originalDefaults = {
          defaultProviderId: payload.settings.defaultProviderId,
          defaultModelId: payload.settings.defaultModelId,
        };
      }

      mock = await startMockLlmServer();
      providerId = await createProviderAndSetDefault(
        request,
        mock.baseUrl,
        `e2e-mock-${Date.now()}`
      );

      ensureCleanSession(sessionName);
      tmux(`new-session -d -s ${sessionName} "sh -lc 'echo AGENT_PANE_READY; exec sh'"`);
      paneId = tmux(`list-panes -t ${sessionName}:0 -F '#{pane_id}'`).trim();
      windowId = tmux(`display-message -p -t ${sessionName}:0 '#{window_id}'`).trim();

      const deviceRes = await request.post('/api/devices', {
        data: {
          name: `e2e-agent-${Date.now()}`,
          type: 'local',
          session: sessionName,
          authMode: 'auto',
        },
      });
      expect(deviceRes.ok()).toBeTruthy();
      const created = (await deviceRes.json()) as { device: { id: string } };
      deviceId = created.device.id;
    });

    test.afterAll(async ({ request }) => {
      if (deviceId) {
        await request.delete(`/api/devices/${deviceId}`).catch(() => undefined);
      }
      // 先复原 settings 再删 provider；原默认 provider 可能已不存在（PATCH 400），失败则清空
      if (originalDefaults) {
        const restored = await request
          .patch('/api/llm/settings', { data: originalDefaults })
          .catch(() => null);
        if (!restored || !restored.ok()) {
          await request
            .patch('/api/llm/settings', {
              data: { defaultProviderId: null, defaultModelId: originalDefaults.defaultModelId },
            })
            .catch(() => undefined);
        }
      }
      if (deadProviderId) {
        await request.delete(`/api/llm/providers/${deadProviderId}`).catch(() => undefined);
      }
      if (providerId) {
        await request.delete(`/api/llm/providers/${providerId}`).catch(() => undefined);
      }
      ensureCleanSession(sessionName);
      mock?.server.close();
    });

    test('create session, send message and stream reply to screen', async ({ page }) => {
      await page.goto(
        `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`
      );
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });

      // 打开 agent 面板
      const panelRoot = page.locator('[data-slot="right-panel"]');
      if ((await panelRoot.getAttribute('data-state')) !== 'expanded') {
        await page.getByTestId('right-panel-trigger').first().click();
      }
      await expect(page.getByTestId('agent-panel')).toBeVisible();

      // 新建 session（绑定当前 pane）
      await page.getByTestId('agent-session-switcher').click();
      await expect(page.getByTestId('agent-session-switcher-menu')).toBeVisible();
      await page.getByTestId('agent-session-create').click();
      await expect(page.getByTestId('agent-session-switcher')).toContainText('New Session');

      // 绑定 chip 显示且有效
      await expect(page.getByTestId('agent-binding-chip')).toBeVisible();
      await expect(page.getByTestId('agent-binding-chip')).toHaveAttribute(
        'data-binding-state',
        'valid',
        { timeout: 15_000 }
      );

      // 发送消息：user 气泡 + assistant 流式文本上屏
      const textarea = page.getByTestId('agent-chat-input-textarea');
      await expect(textarea).toBeEnabled();
      await textarea.fill('hello agent');
      await page.getByTestId('agent-chat-send').click();

      await expect(page.getByTestId('agent-user-message')).toContainText('hello agent');
      await expect(page.getByTestId('agent-chat-thread')).toContainText(REPLY_TEXT, {
        timeout: 20_000,
      });

      // turn 结束：发送按钮回归（停止按钮消失）
      await expect(page.getByTestId('agent-chat-send')).toBeVisible({ timeout: 15_000 });

      // 标题自动生成（验证 STATUS 事件驱动列表刷新链路）
      await expect(page.getByTestId('agent-session-switcher')).toContainText(MOCK_TITLE, {
        timeout: 15_000,
      });

      // 刷新后会话与历史恢复
      await page.reload();
      await expect(page.getByTestId('agent-panel')).toBeVisible();
      await expect(page.getByTestId('agent-chat-thread')).toContainText(REPLY_TEXT, {
        timeout: 15_000,
      });
      await expect(page.getByTestId('agent-user-message')).toContainText('hello agent');
    });

    test('rename and delete session', async ({ page }) => {
      await page.goto(
        `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`
      );
      const panelRoot = page.locator('[data-slot="right-panel"]');
      if ((await panelRoot.getAttribute('data-state')) !== 'expanded') {
        await page.getByTestId('right-panel-trigger').first().click();
      }
      await expect(page.getByTestId('agent-panel')).toBeVisible();

      // 新 context 无 localStorage，先从列表选中上个用例创建的 session
      const switcher = page.getByTestId('agent-session-switcher');
      const menu = page.getByTestId('agent-session-switcher-menu');
      await switcher.click();
      await expect(menu).toBeVisible();
      await expect(menu).toContainText(MOCK_TITLE, { timeout: 15_000 });
      await menu.locator('[data-testid^="agent-session-item-"]', { hasText: MOCK_TITLE }).click();
      await expect(switcher).toContainText(MOCK_TITLE);

      await switcher.click();
      await expect(menu).toBeVisible();

      const renameButton = menu.locator('[data-testid^="agent-session-rename-"]').first();
      await renameButton.click();
      const renameInput = page.getByTestId('agent-session-rename-input');
      await expect(renameInput).toBeVisible();
      await renameInput.fill('Renamed by e2e');
      await page.getByTestId('agent-session-rename-save').click();
      await expect(switcher).toContainText('Renamed by e2e');

      // 删除（带确认）
      await switcher.click();
      await expect(menu).toBeVisible();
      await menu.locator('[data-testid^="agent-session-delete-"]').first().click();
      await expect(page.getByTestId('agent-session-delete-dialog')).toBeVisible();
      await page.getByTestId('agent-session-delete-confirm').click();
      await expect(switcher).toContainText('No session selected');
    });

    test('two tabs stay in sync while streaming', async ({ page, context }) => {
      const paneUrl = `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`;

      await page.goto(paneUrl);
      const panelRoot = page.locator('[data-slot="right-panel"]');
      if ((await panelRoot.getAttribute('data-state')) !== 'expanded') {
        await page.getByTestId('right-panel-trigger').first().click();
      }
      await expect(page.getByTestId('agent-panel')).toBeVisible();

      // 创建 session（写入 localStorage 的 activeSessionId，B 标签页打开即选中同一 session）
      await page.getByTestId('agent-session-switcher').click();
      await page.getByTestId('agent-session-create').click();
      await expect(page.getByTestId('agent-session-switcher')).toContainText('New Session');

      const pageB = await context.newPage();
      await pageB.goto(paneUrl);
      const panelRootB = pageB.locator('[data-slot="right-panel"]');
      if ((await panelRootB.getAttribute('data-state')) !== 'expanded') {
        await pageB.getByTestId('right-panel-trigger').first().click();
      }
      await expect(pageB.getByTestId('agent-panel')).toBeVisible();
      await expect(pageB.getByTestId('agent-session-switcher')).toContainText('New Session');

      // A 发消息，B 通过 WS 订阅同步看到 user 消息与流式回复
      const textarea = page.getByTestId('agent-chat-input-textarea');
      await expect(textarea).toBeEnabled();
      await textarea.fill('sync across tabs');
      await page.getByTestId('agent-chat-send').click();

      await expect(pageB.getByTestId('agent-chat-thread')).toContainText('sync across tabs', {
        timeout: 20_000,
      });
      await expect(pageB.getByTestId('agent-chat-thread')).toContainText(REPLY_TEXT, {
        timeout: 20_000,
      });
      await expect(page.getByTestId('agent-chat-thread')).toContainText(REPLY_TEXT, {
        timeout: 20_000,
      });

      await page.screenshot({
        path: 'test-results/agent-session-two-tabs-tab-a.png',
      });
      await pageB.screenshot({
        path: 'test-results/agent-session-two-tabs-tab-b.png',
      });
      await pageB.close();

      // 清理本用例 session，避免影响后续用例
      await page.getByTestId('agent-session-switcher').click();
      const menu = page.getByTestId('agent-session-switcher-menu');
      await expect(menu).toBeVisible();
      await menu.locator('[data-testid^="agent-session-delete-"]').first().click();
      await page.getByTestId('agent-session-delete-confirm').click();
      await expect(page.getByTestId('agent-session-switcher')).toContainText('No session selected');
    });

    test('confirm flow: approve executes tool then resumes, deny skips execution', async ({
      page,
    }) => {
      const approveToken = `E2E_APPROVE_${Date.now()}`;
      const denyToken = `E2E_DENY_${Date.now()}`;

      await page.goto(
        `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`
      );
      const panelRoot = page.locator('[data-slot="right-panel"]');
      if ((await panelRoot.getAttribute('data-state')) !== 'expanded') {
        await page.getByTestId('right-panel-trigger').first().click();
      }
      await expect(page.getByTestId('agent-panel')).toBeVisible();

      // 新建 session（默认 writeMode=confirm）
      await page.getByTestId('agent-session-switcher').click();
      await page.getByTestId('agent-session-create').click();
      await expect(page.getByTestId('agent-session-switcher')).toContainText('New Session');
      await expect(page.getByTestId('agent-binding-chip')).toHaveAttribute(
        'data-binding-state',
        'valid',
        { timeout: 15_000 }
      );

      // 第一轮：approve —— tool call 出确认卡片，点允许后工具真实执行并续跑
      const textarea = page.getByTestId('agent-chat-input-textarea');
      await expect(textarea).toBeEnabled();
      await textarea.fill(`RUN_COMMAND echo ${approveToken}`);
      await page.getByTestId('agent-chat-send').click();

      const approveButton = page.getByTestId('agent-confirm-approve');
      await expect(approveButton).toBeVisible({ timeout: 20_000 });
      await approveButton.click();
      await expect(page.getByTestId('agent-confirm-approve')).toHaveCount(0, { timeout: 15_000 });

      // 工具被真实执行：echo 输出出现在绑定 pane 屏幕上
      await expect
        .poll(() => tmux(`capture-pane -t '${paneId}' -p`), { timeout: 20_000 })
        .toContain(approveToken);

      // 续跑收尾文本上屏，session 回到 idle（输入可用）
      await expect(page.getByTestId('agent-chat-thread')).toContainText(TOOL_DONE_REPLY, {
        timeout: 20_000,
      });
      await expect(textarea).toBeEnabled({ timeout: 15_000 });

      // 第二轮：deny —— 点拒绝后工具不执行，模型收到拒绝并继续
      await textarea.fill(`RUN_COMMAND echo ${denyToken}`);
      await page.getByTestId('agent-chat-send').click();

      const denyButton = page.getByTestId('agent-confirm-deny');
      await expect(denyButton).toBeVisible({ timeout: 20_000 });
      await denyButton.click();
      await expect(page.getByTestId('agent-confirm-deny')).toHaveCount(0, { timeout: 15_000 });

      // 拒绝态卡片出现，session 回到 idle
      await expect(page.locator('[data-tool-denied="true"]')).toBeVisible({ timeout: 20_000 });
      await expect(textarea).toBeEnabled({ timeout: 20_000 });

      // 被拒绝的命令从未写入 pane
      expect(tmux(`capture-pane -t '${paneId}' -p`)).not.toContain(denyToken);

      // 清理本用例 session
      await page.getByTestId('agent-session-switcher').click();
      const menu = page.getByTestId('agent-session-switcher-menu');
      await expect(menu).toBeVisible();
      await menu.locator('[data-testid^="agent-session-delete-"]').first().click();
      await page.getByTestId('agent-session-delete-confirm').click();
      await expect(page.getByTestId('agent-session-switcher')).toContainText('No session selected');
    });

    test('provider unreachable shows error banner with retry', async ({ page, request }) => {
      // SDK 内置重试(~14s) × run 级重试 3 次 + 间隔，整链路约 60-70s
      test.setTimeout(180_000);

      // 默认 provider 换成指向无人监听端口的地址，让 LLM 调用快速失败
      const deadProviderRes = await request.post('/api/llm/providers', {
        data: {
          name: `e2e-dead-${Date.now()}`,
          protocol: 'openai-chat',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'e2e-dead-key',
        },
      });
      expect(deadProviderRes.ok()).toBeTruthy();
      const deadProvider = (await deadProviderRes.json()) as { provider: { id: string } };
      deadProviderId = deadProvider.provider.id;
      const settingsRes = await request.patch('/api/llm/settings', {
        data: { defaultProviderId: deadProviderId, defaultModelId: 'mock-model' },
      });
      expect(settingsRes.ok()).toBeTruthy();

      await page.goto(
        `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`
      );
      const panelRoot = page.locator('[data-slot="right-panel"]');
      if ((await panelRoot.getAttribute('data-state')) !== 'expanded') {
        await page.getByTestId('right-panel-trigger').first().click();
      }
      await expect(page.getByTestId('agent-panel')).toBeVisible();

      await page.getByTestId('agent-session-switcher').click();
      await page.getByTestId('agent-session-create').click();
      await expect(page.getByTestId('agent-session-switcher')).toContainText('New Session');

      const textarea = page.getByTestId('agent-chat-input-textarea');
      await expect(textarea).toBeEnabled();
      await textarea.fill('this will fail');
      await page.getByTestId('agent-chat-send').click();

      await expect(page.getByTestId('agent-error-banner')).toBeVisible({ timeout: 150_000 });
      await expect(page.getByTestId('agent-error-retry')).toBeVisible();

      // 恢复默认 settings 指回 mock provider 并删除 dead provider，避免污染后续用例与本地环境
      const restoreRes = await request.patch('/api/llm/settings', {
        data: { defaultProviderId: providerId, defaultModelId: 'mock-model' },
      });
      expect(restoreRes.ok()).toBeTruthy();
      const deleteRes = await request.delete(`/api/llm/providers/${deadProviderId}`);
      expect(deleteRes.ok()).toBeTruthy();
      deadProviderId = undefined;
    });
  });
