import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// issue #21：文件列表 node 右键/长按菜单 + 上传/下载/复制路径/发送到 Agent。
// 本机文件浏览走 rsync（与 tmux 无关），故无需连接 tmux 会话。

let sandbox: string;
let rootPath: string;
let deviceId: string;
let rootId: string;

test.afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

test('files: 文件/文件夹右键菜单、复制路径、上传', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  // 1. 本机文件树：临时目录 + 一个文件 + 一个子目录
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tmex-e2e-files-')));
  rootPath = sandbox;
  writeFileSync(join(rootPath, 'hello.txt'), 'hi');
  writeFileSync(join(rootPath, 'sub-marker'), 'x'); // 占位，保证目录非空

  // 2. 经 API 建一个 local 设备 + 指向该目录的 file root
  const devRes = await page.request.post('/api/devices', {
    data: { name: `e2e-files-${Date.now()}`, type: 'local', authMode: 'auto' },
  });
  expect(devRes.ok()).toBeTruthy();
  deviceId = (await devRes.json()).device.id as string;

  const rootRes = await page.request.post('/api/files/roots', {
    data: { deviceId, path: rootPath, enabled: true },
  });
  expect(rootRes.ok()).toBeTruthy();
  rootId = (await rootRes.json()).root.id as string;

  // 3. 打开 Files Tab，展开根目录
  await page.goto('/');
  await page.getByTestId('sidebar-tab-files').click();
  await expect(page.getByTestId('files-tab')).toBeVisible();

  const rootNode = page.getByTestId(`file-dir-${rootId}-${rootPath}`);
  await expect(rootNode).toBeVisible();
  await rootNode.click();

  const filePath = `${rootPath}/hello.txt`;
  const fileNode = page.getByTestId(`file-item-${rootId}-${filePath}`);
  await expect(fileNode).toBeVisible();

  // base-ui 关闭菜单有 ~100ms 退场动画，期间旧 popup 仍在 DOM。每次开新菜单前等旧的完全卸载，
  // 避免两个 [data-slot=context-menu-content] 并存触发 strict-mode（e2e 浏览器语言为 en-US）。
  const menu = page.locator('[data-slot="context-menu-content"]');
  const openMenuOn = async (node: ReturnType<typeof page.getByTestId>) => {
    await expect(menu).toHaveCount(0);
    await node.click({ button: 'right' });
    await expect(menu).toHaveCount(1);
  };

  // 4. 文件右键菜单：Open / Download / Copy absolute path / Copy relative path / Send to Agent
  await openMenuOn(fileNode);
  await expect(menu.getByText('Open', { exact: true })).toBeVisible();
  await expect(menu.getByText('Download', { exact: true })).toBeVisible();
  await expect(menu.getByText('Copy absolute path', { exact: true })).toBeVisible();
  await expect(menu.getByText('Copy relative path', { exact: true })).toBeVisible();
  await expect(menu.getByText('Send to Agent', { exact: true })).toBeVisible();
  // 菜单头部应标明所属设备与完整绝对路径（避免误操作）
  await expect(menu.getByText(filePath, { exact: true })).toBeVisible();
  // 文件菜单头部应显示文件大小（hello.txt = "hi" = 2 B）
  await expect(menu.getByText('2 B', { exact: true })).toBeVisible();

  // 5. 点「复制绝对位置」→ 剪贴板应为该文件绝对路径
  await menu.getByText('Copy absolute path', { exact: true }).click();
  await expect(menu).toHaveCount(0);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(filePath);

  // 6.「复制相对位置」→ 相对树根，应为 hello.txt
  await openMenuOn(fileNode);
  await menu.getByText('Copy relative path', { exact: true }).click();
  await expect(menu).toHaveCount(0);
  const relClip = await page.evaluate(() => navigator.clipboard.readText());
  expect(relClip).toBe('hello.txt');

  // 7. 文件夹右键菜单：Collapse（已展开）/ Upload / Copy 项
  await openMenuOn(rootNode);
  await expect(menu.getByText('Collapse', { exact: true })).toBeVisible();
  await expect(menu.getByText('Upload files here', { exact: true })).toBeVisible();
  await expect(menu.getByText('Copy absolute path', { exact: true })).toBeVisible();

  // 8. 通过菜单分块上传一个文件 → 触发文件选择器 → 进度 toast 出现 → 树中出现该文件
  const uploadName = `uploaded-${Date.now()}.txt`;
  const chooserPromise = page.waitForEvent('filechooser');
  await menu.getByText('Upload files here', { exact: true }).click();
  const chooser = await chooserPromise;
  // 用一个目标文件名上传（filechooser 用源文件路径，远端文件名 = basename(源)）
  const renamedSrc = join(sandbox, uploadName);
  writeFileSync(renamedSrc, 'uploaded content');
  await chooser.setFiles(renamedSrc);

  // 传输 toast 应出现（工作态/成功态），验证分块上传走了进度 UI
  await expect(page.getByTestId('transfer-toast')).toBeVisible({ timeout: 10_000 });

  const uploadedNode = page.getByTestId(`file-item-${rootId}-${rootPath}/${uploadName}`);
  await expect(uploadedNode).toBeVisible({ timeout: 20_000 });
});

test('files: 应用内流式下载（菜单）保存文件', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  const dlSandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tmex-e2e-dl-')));
  const content = 'download-stream-content-12345';
  writeFileSync(join(dlSandbox, 'doc.txt'), content);

  const devRes = await page.request.post('/api/devices', {
    data: { name: `e2e-dl-${Date.now()}`, type: 'local', authMode: 'auto' },
  });
  expect(devRes.ok()).toBeTruthy();
  const deviceId2 = (await devRes.json()).device.id as string;
  const rootRes = await page.request.post('/api/files/roots', {
    data: { deviceId: deviceId2, path: dlSandbox, enabled: true },
  });
  expect(rootRes.ok()).toBeTruthy();
  const rootId2 = (await rootRes.json()).root.id as string;

  await page.goto('/');
  await page.getByTestId('sidebar-tab-files').click();
  await page.getByTestId(`file-dir-${rootId2}-${dlSandbox}`).click();
  const fileNode = page.getByTestId(`file-item-${rootId2}-${dlSandbox}/doc.txt`);
  await expect(fileNode).toBeVisible();

  await fileNode.click({ button: 'right' });
  const menu = page.locator('[data-slot="context-menu-content"]');
  await expect(menu).toHaveCount(1);

  const downloadPromise = page.waitForEvent('download');
  await menu.getByText('Download', { exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('doc.txt');
  const saved = await download.path();
  expect(saved).toBeTruthy();
  if (saved) {
    expect(readFileSync(saved, 'utf8')).toBe(content);
  }

  rmSync(dlSandbox, { recursive: true, force: true });
});

test('files: 上传进行中的 toast 不自动消失、不可手动关闭、可取消', async ({ page }) => {
  const upSandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tmex-e2e-up-')));

  const devRes = await page.request.post('/api/devices', {
    data: { name: `e2e-up-${Date.now()}`, type: 'local', authMode: 'auto' },
  });
  expect(devRes.ok()).toBeTruthy();
  const devId = (await devRes.json()).device.id as string;
  const rootRes = await page.request.post('/api/files/roots', {
    data: { deviceId: devId, path: upSandbox, enabled: true },
  });
  expect(rootRes.ok()).toBeTruthy();
  const rId = (await rootRes.json()).root.id as string;

  // 拖住 chunk PUT，使上传停留在「工作态」，便于断言不消失/不可关闭
  await page.route('**/api/files/upload/**', async (route) => {
    if (route.request().method() === 'PUT') {
      await new Promise((r) => setTimeout(r, 4000));
    }
    await route.continue().catch(() => {});
  });

  await page.goto('/');
  await page.getByTestId('sidebar-tab-files').click();
  const rootNode = page.getByTestId(`file-dir-${rId}-${upSandbox}`);
  await expect(rootNode).toBeVisible();
  await rootNode.click();

  const upName = `slow-${Date.now()}.txt`;
  const src = join(upSandbox, upName);
  writeFileSync(src, 'x'.repeat(64 * 1024)); // 64KB → 1 个被拖住的 chunk
  await rootNode.click({ button: 'right' });
  const menu = page.locator('[data-slot="context-menu-content"]');
  await expect(menu).toHaveCount(1);
  const chooserPromise = page.waitForEvent('filechooser');
  await menu.getByText('Upload files here', { exact: true }).click();
  (await chooserPromise).setFiles(src);

  const toast = page.getByTestId('transfer-toast');
  await expect(toast).toBeVisible();
  // 工作态：有取消按钮，且没有 sonner 关闭按钮（dismissible:false）
  await expect(page.getByTestId('transfer-cancel')).toBeVisible();
  await expect(toast.locator('[data-close-button]')).toHaveCount(0);
  // 不自动消失：等待后仍在；按 Escape 也不关闭
  await page.waitForTimeout(1500);
  await expect(toast).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(toast).toBeVisible();
  // 取消按钮可用：点击后工作态结束（取消按钮消失，toast 进入可关闭的终态）
  // 注：对 local 设备 + 极小文件，rsync 推送是瞬时原子操作，"取消能否阻止落盘"取决于
  // 取消时机与 Playwright 路由拦截语义，非本用例要断言的契约；这里只验证 UI 取消接线。
  await page.getByTestId('transfer-cancel').click();
  await expect(page.getByTestId('transfer-cancel')).toHaveCount(0, { timeout: 10_000 });

  await page.unroute('**/api/files/upload/**');
  rmSync(upSandbox, { recursive: true, force: true });
});
