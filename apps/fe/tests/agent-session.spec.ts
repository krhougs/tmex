// Agent 会话端到端：mock OpenAI server 注册为 provider，
// 覆盖 创建/发消息流式上屏/续跑确认流/provider 不可达 error banner。
// UI 已从右侧 Panel 迁移到左 Sidebar 的 Agent Tab；会话挂在 Panes 树里。
// 进入 Agent Tab 且当前路由有 pane 时自动进入草稿态（直接可输入），
// 首条消息发送才落库创建 session。

import { type Server, createServer } from 'node:http';
import { type APIRequestContext, type Page, expect, test } from '@playwright/test';
import { ensureCleanSession, tmux } from './helpers/tmux';

const REPLY_TEXT = 'Hello from mock e2e agent reply';
const MOCK_TITLE = 'Mock Session Title';
const TOOL_DONE_REPLY = 'Tool finished mock follow-up reply';

interface MockLlmServer {
  server: Server;
  port: number;
  baseUrl: string;
}

// 进入 Agent Tab（桌面端 sidebar 默认展开，直接点 Tab 触发器）。
// 当前路由有 pane 时 agent-tab 会自动进入草稿态，输入区即可用。
async function openAgentTab(page: Page): Promise<void> {
  await page.getByTestId('sidebar-tab-agent').click();
  await expect(page.getByTestId('agent-tab')).toBeVisible();
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
          // 含 SLOW_REPLY 标记的轮次拉长流式过程，让 running 态可被观测（队列用例）
          const slow = lastUserText.includes('SLOW_REPLY');
          res.write(sseChunk({ role: 'assistant', content: '' }));
          const words = replyText.split(' ');
          const finish = (): void => {
            res.write(sseChunk({}, 'stop'));
            res.write('data: [DONE]\n\n');
            res.end();
          };
          if (slow) {
            let i = 0;
            const tick = (): void => {
              if (i >= words.length) {
                finish();
                return;
              }
              res.write(sseChunk({ content: `${words[i]} ` }));
              i += 1;
              setTimeout(tick, 600);
            };
            tick();
            return;
          }
          for (const word of words) {
            res.write(sseChunk({ content: `${word} ` }));
          }
          finish();
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

      // 进入 Agent Tab → 当前 pane 自动起草，输入区可用（无需手动新建）
      await openAgentTab(page);
      const textarea = page.getByTestId('agent-chat-input-textarea');
      await expect(textarea).toBeEnabled();

      // 发送消息：草稿落库创建 session，user 气泡 + assistant 流式文本上屏
      await textarea.fill('hello agent');
      await page.getByTestId('agent-chat-send').click();

      await expect(page.getByTestId('agent-user-message')).toContainText('hello agent');
      await expect(page.getByTestId('agent-chat-thread')).toContainText(REPLY_TEXT, {
        timeout: 20_000,
      });

      // session 落库后绑定 chip 显示且有效
      await expect(page.getByTestId('agent-binding-chip')).toBeVisible();
      await expect(page.getByTestId('agent-binding-chip')).toHaveAttribute(
        'data-binding-state',
        'valid',
        { timeout: 15_000 }
      );

      // turn 结束：发送按钮回归（停止按钮消失）
      await expect(page.getByTestId('agent-chat-send')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('agent-chat-stop')).toHaveCount(0);

      // 标题自动生成：Panes 树里出现对应会话节点（验证 STATUS 事件驱动列表刷新链路）
      await page.getByTestId('sidebar-tab-panes').click();
      await expect(
        page.locator('[data-testid^="agent-session-item-"]', { hasText: MOCK_TITLE })
      ).toBeVisible({ timeout: 15_000 });

      // 刷新后会话与历史恢复（sidebarTab 与 activeSessionId 均持久化）
      await page.reload();
      await openAgentTab(page);
      await expect(page.getByTestId('agent-chat-thread')).toContainText(REPLY_TEXT, {
        timeout: 15_000,
      });
      await expect(page.getByTestId('agent-user-message')).toContainText('hello agent');
    });

    test('rename and delete session', async ({ page }) => {
      await page.goto(
        `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`
      );
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });

      // 串行套件共享 pane，前序用例已留存会话；先记录已有会话 id，
      // 再显式新建并发消息落库，挑出新出现的 id 精准定位（标题统一是 MOCK_TITLE）
      await openAgentTab(page);
      await page.getByTestId('sidebar-tab-panes').click();
      const existingIds = new Set(
        await page
          .locator('[data-testid^="agent-session-item-"]')
          .evaluateAll((nodes) =>
            nodes.map((n) => n.getAttribute('data-testid')?.replace('agent-session-item-', ''))
          )
      );

      // 进入 Agent Tab 即自动进入草稿态（干净空会话），无需点新建按钮
      // （草稿态下新建按钮被隐藏，因为草稿本身就是「新会话」状态）
      await openAgentTab(page);
      const textarea = page.getByTestId('agent-chat-input-textarea');
      await expect(textarea).toBeEnabled();
      await textarea.fill('rename target session');
      await page.getByTestId('agent-chat-send').click();
      await expect(page.getByTestId('agent-chat-thread')).toContainText(REPLY_TEXT, {
        timeout: 20_000,
      });

      // 标题自动生成后切到 Panes 树，挑出新出现的会话节点
      await page.getByTestId('sidebar-tab-panes').click();
      let sessionId = '';
      await expect
        .poll(
          async () => {
            const ids = await page
              .locator('[data-testid^="agent-session-item-"]')
              .evaluateAll((nodes) =>
                nodes.map((n) =>
                  n.getAttribute('data-testid')?.replace('agent-session-item-', '')
                )
              );
            const fresh = ids.find((id): id is string => Boolean(id) && !existingIds.has(id));
            if (fresh) sessionId = fresh;
            return sessionId;
          },
          { timeout: 15_000 }
        )
        .not.toBe('');

      // Rename：打开菜单 → Rename → 改名 → 断言树里标题更新
      await page.getByTestId(`agent-session-menu-${sessionId}`).click();
      await page.getByTestId('agent-session-rename').click();
      const renameInput = page.getByTestId('agent-session-rename-input');
      await expect(renameInput).toBeVisible();
      const renamedTitle = `Renamed ${Date.now()}`;
      await renameInput.fill(renamedTitle);
      await page.getByTestId('agent-session-rename-save').click();

      const renamedItem = page.locator(`[data-testid="agent-session-item-${sessionId}"]`);
      await expect(renamedItem).toContainText(renamedTitle, { timeout: 15_000 });

      // Delete：打开菜单 → Delete → 确认 → 断言节点消失
      await page.getByTestId(`agent-session-menu-${sessionId}`).click();
      await page.getByTestId('agent-session-delete').click();
      await page.getByTestId('agent-session-delete-confirm').click();

      await expect(
        page.locator(`[data-testid="agent-session-item-${sessionId}"]`)
      ).toHaveCount(0, { timeout: 15_000 });
    });

    test('running session enqueues further messages', async ({ page }) => {
      await page.goto(
        `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`
      );
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });
      await openAgentTab(page);

      const textarea = page.getByTestId('agent-chat-input-textarea');
      await expect(textarea).toBeEnabled();

      // 发首条消息进入 running（SLOW_REPLY 拉长流式，stop 按钮出现）
      await textarea.fill('first message SLOW_REPLY');
      await page.getByTestId('agent-chat-send').click();
      await expect(page.getByTestId('agent-chat-stop')).toBeVisible({ timeout: 15_000 });

      // running 中输入框仍可用（不再禁用），再发消息进队列
      await expect(textarea).toBeEnabled();
      await textarea.fill('queued while running');
      await page.getByTestId('agent-chat-send').click();
      await expect(page.getByTestId('agent-queue')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('agent-queue')).toContainText('queued while running');

      // turn 结束后回到 idle，stop 按钮消失，发送按钮回归
      await expect(page.getByTestId('agent-chat-stop')).toHaveCount(0, { timeout: 20_000 });
      await expect(page.getByTestId('agent-chat-send')).toBeVisible();
    });

    test('two tabs stay in sync while streaming', async ({ page, context }) => {
      test.setTimeout(90_000);
      const paneUrl = `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`;

      await page.goto(paneUrl);
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });
      await openAgentTab(page);

      // 发消息创建 session（activeSessionId 持久化进同 context 的 localStorage，
      // B 标签页打开即选中同一 session）。SLOW_REPLY 拉长流式，确保 B 挂载订阅时
      // 本轮仍在进行中，走 WS 推流同步路径。
      const textarea = page.getByTestId('agent-chat-input-textarea');
      await expect(textarea).toBeEnabled();
      await textarea.fill('sync across tabs SLOW_REPLY');
      await page.getByTestId('agent-chat-send').click();
      await expect(page.getByTestId('agent-user-message')).toContainText('sync across tabs');

      const pageB = await context.newPage();
      await pageB.goto(paneUrl);
      await expect(pageB.locator('.xterm')).toBeVisible({ timeout: 20_000 });

      // B 从 Panes 树显式选中同一 session（setActiveSession→subscribe+loadHistory，
      // 比依赖 rehydration 时序更稳），随后通过 WS 订阅/历史回放同步内容
      await pageB.getByTestId('sidebar-tab-panes').click();
      const sessionItemB = pageB
        .locator('[data-testid^="agent-session-item-"]')
        .first();
      await expect(sessionItemB).toBeVisible({ timeout: 20_000 });
      await sessionItemB.click();
      await expect(pageB.getByTestId('agent-tab')).toBeVisible();

      await expect(pageB.getByTestId('agent-chat-thread')).toContainText('sync across tabs', {
        timeout: 30_000,
      });
      await expect(pageB.getByTestId('agent-chat-thread')).toContainText(REPLY_TEXT, {
        timeout: 30_000,
      });
      await expect(page.getByTestId('agent-chat-thread')).toContainText(REPLY_TEXT, {
        timeout: 30_000,
      });

      await page.screenshot({
        path: 'test-results/agent-session-two-tabs-tab-a.png',
      });
      await pageB.screenshot({
        path: 'test-results/agent-session-two-tabs-tab-b.png',
      });
      await pageB.close();
    });

    test('confirm flow: approve executes tool then resumes, deny skips execution', async ({
      page,
    }) => {
      const approveToken = `E2E_APPROVE_${Date.now()}`;
      const denyToken = `E2E_DENY_${Date.now()}`;

      await page.goto(
        `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`
      );
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });

      // 进入 Agent Tab 即得到干净草稿会话（默认 writeMode=confirm）
      await openAgentTab(page);
      const textarea = page.getByTestId('agent-chat-input-textarea');
      await expect(textarea).toBeEnabled();

      // 第一轮：approve —— tool call 出确认卡片，点允许后工具真实执行并续跑
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
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });

      // 进入 Agent Tab 即得到干净草稿会话，无需点新建按钮
      await openAgentTab(page);
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
