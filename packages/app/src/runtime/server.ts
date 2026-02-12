import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { CryptoDecryptError } from '../../../../apps/gateway/src/crypto/errors';
import { createGatewayRuntime } from '../../../../apps/gateway/src/runtime';
import { t } from '../i18n';

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function contentTypeByPath(path: string): string | undefined {
  const ext = extname(path).toLowerCase();
  return MIME_MAP[ext];
}

function resolveStaticRoot(): string {
  if (process.env.TMEX_FE_DIST_DIR) {
    return resolve(process.env.TMEX_FE_DIST_DIR);
  }

  return resolve(import.meta.dir, '../../resources/fe-dist');
}

function resolveRequestedFile(staticRoot: string, pathname: string): string | null {
  const root = resolve(staticRoot);
  const decoded = decodeURIComponent(pathname);
  const normalized = normalize(decoded).replace(/^\.\.(\/|\\|$)/, '');
  const requested = normalized === '/' ? '/index.html' : normalized;
  const absolutePath = resolve(root, `.${requested}`);

  if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
    return null;
  }

  return absolutePath;
}

async function serveFrontend(req: Request, staticRoot: string): Promise<Response> {
  const url = new URL(req.url);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(t('runtime.methodNotAllowed'), { status: 405 });
  }

  const requestedPath = resolveRequestedFile(staticRoot, url.pathname);
  if (!requestedPath) {
    return new Response(t('runtime.forbidden'), { status: 403 });
  }

  const indexPath = join(staticRoot, 'index.html');
  const targetPath = existsSync(requestedPath) ? requestedPath : indexPath;

  if (!existsSync(targetPath)) {
    return new Response(t('runtime.frontendMissing'), { status: 500 });
  }

  const headers = new Headers();
  const type = contentTypeByPath(targetPath);
  if (type) {
    headers.set('Content-Type', type);
  }

  return new Response(Bun.file(targetPath), { headers });
}

async function main(): Promise<void> {
  const host = process.env.TMEX_BIND_HOST || '127.0.0.1';
  const port = Number(process.env.GATEWAY_PORT || '9883');
  const staticRoot = resolveStaticRoot();

  const gateway = await createGatewayRuntime();

  const server = Bun.serve({
    hostname: host,
    port,
    async fetch(req, bunServer) {
      const gatewayResponse = await gateway.handleRequest(req, bunServer);
      if (gatewayResponse !== undefined) {
        return gatewayResponse;
      }

      return await serveFrontend(req, staticRoot);
    },
    websocket: gateway.websocket,
  });

  gateway.onRestartRequested(async () => {
    console.log(`[tmex] ${t('runtime.restartRequested')}`);
    await gateway.stop();
    server.stop(true);
    process.exit(0);
  });

  console.log(`[tmex] ${t('runtime.started', { url: `http://${host}:${port}` })}`);
}

try {
  await main();
} catch (error) {
  if (error instanceof CryptoDecryptError) {
    console.error('[tmex][fatal] 启动失败：检测到无法解密的敏感数据。');
    console.error(
      `[tmex][fatal] 上下文：scope=${error.context.scope} id=${error.context.entityId ?? '-'} field=${error.context.field ?? '-'}`
    );
    console.error(
      '[tmex][fatal] 请检查 app.env 中 TMEX_MASTER_KEY 是否与当前数据库匹配；如果数据库来自其他环境，请使用原密钥或手动重建相关密文配置。'
    );
    console.error('[tmex][fatal] 详细信息：', error.message);
  } else {
    console.error('[tmex][fatal] 启动失败：', error);
  }
  throw error;
}
