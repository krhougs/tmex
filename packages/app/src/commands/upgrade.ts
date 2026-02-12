import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultInstallDir } from '../constants';
import { t } from '../i18n';
import { checkBunVersion } from '../lib/bun';
import { readEnvFile } from '../lib/env-file';
import { pathExists } from '../lib/fs-utils';
import {
  backupInstallArtifacts,
  deployRuntimeFiles,
  restoreInstallArtifacts,
  writeInstallMeta,
  writeRunScript,
} from '../lib/install';
import {
  createInstallLayout,
  resolveInstallDir,
  resolvePackageLayout,
} from '../lib/install-layout';
import { readJsonFile } from '../lib/json-file';
import { runCommand } from '../lib/process';
import { installService, stopService } from '../lib/service';
import { asBoolean, asString } from '../lib/validate';
import { readPackageVersion } from '../lib/version';
import type { InstallMeta, ParsedArgs } from '../types';

async function delegateUpgrade(parsed: ParsedArgs, targetVersion: string): Promise<void> {
  const args = ['--yes', `tmex-cli@${targetVersion}`, 'upgrade', '--apply-current-package'];

  const passthrough = ['install-dir', 'service-name', 'yes', 'lang'];
  for (const key of passthrough) {
    const value = parsed.flags[key];
    if (value === undefined) continue;

    if (value === true) {
      args.push(`--${key}`);
    } else {
      args.push(`--${key}`, String(value));
    }
  }

  const result = await runCommand('npx', args, { stdio: 'inherit' });
  if (result.code !== 0) {
    throw new Error(t('upgrade.delegateFailed', { code: result.code }));
  }
}

async function verifyHealth(installLayout: ReturnType<typeof createInstallLayout>): Promise<void> {
  if (!(await pathExists(installLayout.envPath))) {
    return;
  }

  const env = await readEnvFile(installLayout.envPath).catch(() => ({}));
  const port = String(env.GATEWAY_PORT || '9883');
  const hostFromEnv = String(env.TMEX_BIND_HOST || '127.0.0.1');
  const host = hostFromEnv === '0.0.0.0' ? '127.0.0.1' : hostFromEnv;

  const url = `http://${host}:${port}/healthz`;
  const startedAt = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - startedAt < 30_000) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
      if (response.ok) {
        return;
      }
      lastError = new Error(t('upgrade.healthFailed', { status: response.status }));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw lastError || new Error(t('upgrade.healthFailed', { status: 'timeout' }));
}

export async function runUpgrade(parsed: ParsedArgs): Promise<void> {
  const applyCurrent = asBoolean(parsed.flags['apply-current-package']) ?? false;
  const targetVersion = asString(parsed.flags.version) || 'latest';

  if (!applyCurrent) {
    await delegateUpgrade(parsed, targetVersion);
    return;
  }

  const installDir = resolveInstallDir(
    asString(parsed.flags['install-dir']) || defaultInstallDir(process.platform)
  );
  const installLayout = createInstallLayout(installDir);

  if (!(await pathExists(installLayout.metaPath))) {
    throw new Error(t('upgrade.missingMeta', { path: installLayout.metaPath }));
  }

  const bun = await checkBunVersion();
  if (!bun.ok || !bun.path) {
    throw new Error(bun.reason || t('bun.checkFailed'));
  }

  const meta = await readJsonFile<InstallMeta>(installLayout.metaPath);
  const packageLayout = await resolvePackageLayout(import.meta.url);

  const backupDir = await mkdtemp(join(tmpdir(), 'tmex-upgrade-'));

  try {
    await stopService(meta.serviceName, installDir);
    await backupInstallArtifacts(installLayout, backupDir);

    await deployRuntimeFiles(packageLayout, installLayout);
    await writeRunScript(installLayout, bun.path);

    const cliVersion = await readPackageVersion(packageLayout.packageRoot);
    meta.updatedAt = new Date().toISOString();
    meta.cliVersion = cliVersion;
    await writeInstallMeta(installLayout, meta);

    await installService({
      serviceName: meta.serviceName,
      runScriptPath: installLayout.runScriptPath,
      installDir,
      autostart: meta.autostart,
    });

    await verifyHealth(installLayout);

    console.log(`[tmex] ${t('upgrade.done')}`);
    console.log(`- ${t('upgrade.summary.targetVersion')}: ${targetVersion}`);
    console.log(`- ${t('upgrade.summary.installDir')}: ${installDir}`);
  } catch (error) {
    console.error(`[tmex] ${t('upgrade.failedRollingBack')}`);
    await restoreInstallArtifacts(installLayout, backupDir);
    await installService({
      serviceName: meta.serviceName,
      runScriptPath: installLayout.runScriptPath,
      installDir,
      autostart: meta.autostart,
    }).catch(() => null);

    throw error;
  } finally {
    await rm(backupDir, { recursive: true, force: true }).catch(() => null);
  }
}
