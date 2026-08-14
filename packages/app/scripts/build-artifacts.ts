// 纯构建产物输出：Rust Gateway targets + fe dist + manifest.json。
// 不包含任何安装器 / 服务注册逻辑；构建本体直接复用 bundle-resources.sh 与
// build-runtime.ts（spawn 调用而非复制逻辑，避免漂移）。
//
// 用法：bun scripts/build-artifacts.ts --outdir <dir> [--smoke]
//   --outdir  必填，产物输出目录（gateway-artifacts/ fe-dist/ manifest.json）
//   --smoke   可选，构建后用产物起一个临时实例，curl /healthz 通过即杀掉

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { buildManifest } from '../src/lib/artifacts-manifest';
import {
  gatewayArtifactEntry,
  gatewayTargetFor,
  parseGatewayArtifactManifest,
  verifyGatewayArtifact,
} from '../src/lib/gateway-artifacts';

const pkgRoot = resolve(import.meta.dir, '..');

// 生产/开发实例端口，冒烟绝不使用
const FORBIDDEN_PORTS = new Set([9663, 9883, 19663, 19883]);
const SMOKE_STARTUP_TIMEOUT_MS = 60_000;
const SMOKE_POLL_INTERVAL_MS = 500;
const SMOKE_PORT_ATTEMPTS = 3;

interface CliArgs {
  outdir: string;
  smoke: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let outdir: string | null = null;
  let smoke = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--outdir') {
      const value = argv[i + 1];
      if (!value) {
        fail('--outdir requires a value');
      }
      outdir = value;
      i++;
    } else if (arg === '--smoke') {
      smoke = true;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (!outdir) {
    fail('usage: bun scripts/build-artifacts.ts --outdir <dir> [--smoke]');
  }
  return { outdir: resolve(outdir), smoke };
}

function fail(message: string): never {
  console.error(`[build:artifacts] ${message}`);
  process.exit(1);
}

function step(label: string, command: string, args: string[]): void {
  console.log(`[build:artifacts] ${label}`);
  const result = spawnSync(command, args, { cwd: pkgRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    fail(`${label} failed (exit ${result.status ?? 'signal'})`);
  }
}

function listFilesRecursive(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function randomSmokePort(): number {
  let port: number;
  do {
    port = 20000 + Math.floor(Math.random() * 40000);
  } while (FORBIDDEN_PORTS.has(port));
  return port;
}

async function smokeTest(outdir: string): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), 'tmex-artifacts-smoke-'));
  const fakeTmux = join(workDir, 'tmux-disabled');
  writeFileSync(fakeTmux, '#!/usr/bin/env sh\nexit 127\n');
  chmodSync(fakeTmux, 0o755);

  try {
    for (let attempt = 1; attempt <= SMOKE_PORT_ATTEMPTS; attempt++) {
      const port = randomSmokePort();
      console.log(`[build:artifacts] smoke attempt ${attempt}: 127.0.0.1:${port}`);
      if (await smokeRunOnce(outdir, workDir, fakeTmux, port, attempt)) {
        return;
      }
    }
    fail(`smoke test failed after ${SMOKE_PORT_ATTEMPTS} attempts`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function smokeRunOnce(
  outdir: string,
  workDir: string,
  fakeTmux: string,
  port: number,
  attempt: number
): Promise<boolean> {
  const dbPath = join(workDir, `smoke-${attempt}.db`);
  const gatewayRoot = join(outdir, 'gateway-artifacts');
  const gatewayManifest = parseGatewayArtifactManifest(
    JSON.parse(readFileSync(join(gatewayRoot, 'manifest.json'), 'utf8')) as unknown,
    { requireAllTargets: true }
  );
  const gatewayBinary = await verifyGatewayArtifact(
    gatewayRoot,
    gatewayArtifactEntry(gatewayManifest, gatewayTargetFor())
  );
  const proc = Bun.spawn([gatewayBinary, '--tmux-namespace', 'tmex-artifact-smoke'], {
    cwd: workDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      GATEWAY_PORT: String(port),
      TMEX_BIND_HOST: '127.0.0.1',
      DATABASE_URL: dbPath,
      TMEX_MASTER_KEY: randomBytes(32).toString('base64'),
      TMEX_FE_DIST_DIR: join(outdir, 'fe-dist'),
      TMEX_TMUX_BIN: fakeTmux,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const deadline = Date.now() + SMOKE_STARTUP_TIMEOUT_MS;
  let healthy = false;

  try {
    while (Date.now() < deadline) {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        break;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.status === 200) {
          healthy = true;
          break;
        }
      } catch {
        // 尚未就绪，继续等
      }
      await Bun.sleep(SMOKE_POLL_INTERVAL_MS);
    }
  } finally {
    proc.kill();
    await proc.exited;
  }

  if (healthy) {
    console.log(`[build:artifacts] smoke ok: GET /healthz -> 200 (port ${port})`);
    return true;
  }

  console.error(`[build:artifacts] smoke attempt ${attempt} failed; server output:`);
  console.error(await new Response(proc.stdout).text());
  console.error(await new Response(proc.stderr).text());
  return false;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  step('bundling fe dist', 'bash', ['./scripts/bundle-resources.sh']);
  step('bundling Rust Gateway artifacts', 'bun', ['scripts/build-runtime.ts']);

  mkdirSync(args.outdir, { recursive: true });
  const copies: Array<[string, string]> = [
    ['resources/gateway-artifacts', 'gateway-artifacts'],
    ['resources/fe-dist', 'fe-dist'],
  ];
  for (const [src, dest] of copies) {
    const target = join(args.outdir, dest);
    rmSync(target, { recursive: true, force: true });
    cpSync(join(pkgRoot, src), target, { recursive: true });
  }

  // manifest：版本号与 build-runtime.ts 同源（packages/app/package.json）
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
    version?: string;
  };
  const files = copies
    .flatMap(([, dest]) => listFilesRecursive(join(args.outdir, dest)))
    .map((absolute) => ({
      path: relative(args.outdir, absolute).split(sep).join('/'),
      content: readFileSync(absolute) as Uint8Array,
    }));
  const manifest = buildManifest(pkg.version ?? '0.0.0', new Date().toISOString(), files);
  writeFileSync(join(args.outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[build:artifacts] wrote ${manifest.files.length} entries to manifest.json`);

  if (args.smoke) {
    await smokeTest(args.outdir);
  }

  console.log(`[build:artifacts] done: ${args.outdir}`);
}

await main();
