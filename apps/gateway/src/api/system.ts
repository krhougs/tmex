import type { StartUpgradeRequest } from '@tmex/shared';
import { t } from '../i18n';
import { checkForUpdate, getSystemInfo, upgradeController } from '../system';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function handleSystemApiRequest(
  req: Request,
  path: string
): Response | Promise<Response> | undefined {
  if (path === '/api/system/info' && req.method === 'GET') {
    return json(getSystemInfo());
  }

  if (path === '/api/system/update-check' && req.method === 'GET') {
    return handleUpdateCheck();
  }

  if (path === '/api/system/upgrade' && req.method === 'GET') {
    return json(upgradeController.status());
  }

  if (path === '/api/system/upgrade' && req.method === 'POST') {
    return handleStartUpgrade(req);
  }

  return undefined;
}

async function handleUpdateCheck(): Promise<Response> {
  try {
    return json(await checkForUpdate());
  } catch {
    return json({ error: t('apiError.updateCheckFailed') }, 502);
  }
}

async function handleStartUpgrade(req: Request): Promise<Response> {
  const info = getSystemInfo();
  if (!info.canSelfUpdate) {
    return json({ error: t('apiError.upgradeNotAllowed') }, 403);
  }

  let version = '';
  try {
    const body = (await req.json()) as StartUpgradeRequest;
    version = (body?.version ?? '').trim();
  } catch {
    version = '';
  }

  if (!version) {
    return json({ error: t('apiError.upgradeVersionRequired') }, 400);
  }

  const started = upgradeController.start(version);
  if (!started) {
    return json({ ...upgradeController.status(), error: t('apiError.upgradeInProgress') }, 409);
  }

  return json(upgradeController.status());
}
