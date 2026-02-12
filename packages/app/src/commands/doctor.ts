import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultInstallDir } from '../constants';
import { t } from '../i18n';
import { checkBunVersion } from '../lib/bun';
import { readEnvFile } from '../lib/env-file';
import { pathExists } from '../lib/fs-utils';
import { createInstallLayout, resolveInstallDir } from '../lib/install-layout';
import { readJsonFile } from '../lib/json-file';
import { isSupportedPlatform } from '../lib/platform';
import { runCommand } from '../lib/process';
import { getServiceStatus } from '../lib/service';
import { asBoolean, asString } from '../lib/validate';
import type { DoctorCheck, InstallMeta, ParsedArgs } from '../types';

async function checkCommandExists(
  bin: string,
  args: string[],
  id: string,
  okMessage: string,
  failMessage: string
): Promise<DoctorCheck> {
  const result = await runCommand(bin, args, { stdio: 'pipe' }).catch(() => null);
  if (result?.code === 0) {
    return { id, level: 'pass', message: okMessage, detail: result.stdout.trim() };
  }
  return { id, level: 'fail', message: failMessage, detail: result?.stderr || result?.stdout };
}

function printChecks(checks: DoctorCheck[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ checks }, null, 2));
    return;
  }

  for (const check of checks) {
    const prefix = check.level === 'pass' ? 'PASS' : check.level === 'warn' ? 'WARN' : 'FAIL';
    console.log(`[${prefix}] ${check.message}`);
    if (check.detail) {
      console.log(`  ${check.detail.trim()}`);
    }
  }
}

export async function runDoctor(parsed: ParsedArgs): Promise<void> {
  const json = asBoolean(parsed.flags.json) ?? false;
  const installDirFlag = asString(parsed.flags['install-dir']);
  const installDir = resolveInstallDir(installDirFlag || defaultInstallDir(process.platform));
  const installLayout = createInstallLayout(installDir);

  const checks: DoctorCheck[] = [];

  if (!isSupportedPlatform()) {
    checks.push({
      id: 'platform',
      level: 'warn',
      message: t('doctor.platform.unsupported', { platform: process.platform }),
    });
  } else {
    checks.push({
      id: 'platform',
      level: 'pass',
      message: t('doctor.platform.supported', { platform: process.platform }),
    });
  }

  const bun = await checkBunVersion();
  if (bun.ok) {
    checks.push({
      id: 'bun',
      level: 'pass',
      message: t('doctor.bun.ok', { version: bun.version }),
      detail: bun.path,
    });
  } else {
    checks.push({
      id: 'bun',
      level: 'fail',
      message: t('doctor.bun.fail', { reason: bun.reason || t('bun.checkFailed') }),
      detail: bun.path,
    });
  }

  checks.push(
    await checkCommandExists('tmux', ['-V'], 'tmux', t('doctor.tmux.ok'), t('doctor.tmux.fail'))
  );
  const ssh = await runCommand('ssh', ['-V'], { stdio: 'pipe' }).catch(() => null);
  if (ssh?.code === 0) {
    checks.push({
      id: 'ssh',
      level: 'pass',
      message: t('doctor.ssh.ok'),
      detail: (ssh.stderr || ssh.stdout).trim(),
    });
  } else {
    checks.push({ id: 'ssh', level: 'warn', message: t('doctor.ssh.missing') });
  }

  let healthHost = '127.0.0.1';
  let healthPort = '9883';
  if (await pathExists(installDir)) {
    checks.push({
      id: 'install-dir',
      level: 'pass',
      message: t('doctor.installDir.exists', { installDir }),
    });
  } else {
    checks.push({
      id: 'install-dir',
      level: 'warn',
      message: t('doctor.installDir.missing', { installDir }),
    });
  }

  if (await pathExists(installLayout.envPath)) {
    checks.push({
      id: 'env',
      level: 'pass',
      message: t('doctor.env.exists', { envPath: installLayout.envPath }),
    });

    const env = await readEnvFile(installLayout.envPath);
    const required = ['TMEX_MASTER_KEY', 'DATABASE_URL', 'GATEWAY_PORT', 'TMEX_BIND_HOST'];
    for (const key of required) {
      if (!env[key]) {
        checks.push({
          id: `env.${key}`,
          level: 'fail',
          message: t('doctor.env.keyMissing', { key }),
        });
      }
    }

    const dbPath = env.DATABASE_URL;
    if (dbPath) {
      const resolved = resolve(dbPath);
      const exists = await pathExists(resolved);
      if (!exists) {
        checks.push({
          id: 'db',
          level: 'warn',
          message: t('doctor.db.missing', { path: resolved }),
        });
      } else {
        const st = await stat(resolved);
        checks.push({
          id: 'db',
          level: 'pass',
          message: t('doctor.db.exists', { path: resolved }),
          detail: `${st.size} bytes`,
        });
      }
    }

    const port = env.GATEWAY_PORT;
    if (port) {
      healthPort = port;
      const portNum = Number(port);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        checks.push({
          id: 'port',
          level: 'fail',
          message: t('doctor.port.invalid', { value: port }),
        });
      }
    }
    if (env.TMEX_BIND_HOST) {
      healthHost = env.TMEX_BIND_HOST;
    }
  } else {
    checks.push({
      id: 'env',
      level: 'warn',
      message: t('doctor.env.missing', { envPath: installLayout.envPath }),
    });
  }

  let serviceName = asString(parsed.flags['service-name']) || 'tmex';
  if (await pathExists(installLayout.metaPath)) {
    const meta = await readJsonFile<InstallMeta>(installLayout.metaPath).catch(() => null);
    if (meta?.serviceName) {
      serviceName = meta.serviceName;
    }
  }

  const status = await getServiceStatus(serviceName, installDir);
  if (status.manager === 'none') {
    checks.push({
      id: 'service',
      level: 'warn',
      message: t('doctor.service.noManager', { detail: status.detail || '' }),
    });
  } else if (!status.installed) {
    checks.push({
      id: 'service',
      level: 'warn',
      message: t('doctor.service.notInstalled', { serviceName }),
      detail: status.detail,
    });
  } else if (!status.running) {
    checks.push({
      id: 'service',
      level: 'warn',
      message: t('doctor.service.notRunning', { serviceName }),
      detail: status.detail,
    });
  } else {
    checks.push({
      id: 'service',
      level: 'pass',
      message: t('doctor.service.running', { serviceName }),
      detail: status.detail,
    });
  }

  const healthUrl = `http://${healthHost}:${healthPort}/healthz`;
  const normalizedHealthUrl =
    healthHost === '0.0.0.0' ? `http://127.0.0.1:${healthPort}/healthz` : healthUrl;
  const healthResponse = await fetch(normalizedHealthUrl, {
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  if (healthResponse?.ok) {
    checks.push({
      id: 'healthz',
      level: 'pass',
      message: t('doctor.health.pass', { url: normalizedHealthUrl }),
    });
  } else {
    checks.push({
      id: 'healthz',
      level: 'warn',
      message: t('doctor.health.fail', { url: normalizedHealthUrl }),
    });
  }

  printChecks(checks, json);

  const failed = checks.some((check) => check.level === 'fail');
  if (failed) {
    process.exitCode = 1;
  }
}
