import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  DEFAULT_SERVICE_NAME,
  defaultDatabasePath,
  defaultHost,
  defaultInstallDir,
  defaultPort,
} from '../constants';
import { t } from '../i18n';
import { checkBunVersion } from '../lib/bun';
import { writeEnvFile } from '../lib/env-file';
import { ensureDir, pathExists } from '../lib/fs-utils';
import {
  buildAppEnvValues,
  deployRuntimeFiles,
  ensureInstallDir,
  generateMasterKey,
  writeInstallMeta,
  writeRunScript,
} from '../lib/install';
import {
  createInstallLayout,
  resolveInstallDir,
  resolvePackageLayout,
} from '../lib/install-layout';
import { detectServiceManager } from '../lib/platform';
import { promptConfirm, promptText } from '../lib/prompt';
import { installService, serviceHint } from '../lib/service';
import { asBoolean, asString, assertNonEmpty, parsePort } from '../lib/validate';
import { readPackageVersion } from '../lib/version';
import type { InitConfig, InstallMeta, ParsedArgs } from '../types';

function mustGetStringFlag(flags: ParsedArgs['flags'], key: string): string {
  const value = asString(flags[key]);
  if (!value) {
    throw new Error(t('errors.args.missingFlag', { flag: key }));
  }
  return value;
}

function mustGetBooleanFlag(flags: ParsedArgs['flags'], key: string): boolean {
  const value = asBoolean(flags[key]);
  if (value === undefined) {
    throw new Error(t('errors.args.invalidFlag', { flag: key, value: String(flags[key]) }));
  }
  return value;
}

async function directoryHasContent(path: string): Promise<boolean> {
  if (!(await pathExists(path))) {
    return false;
  }

  const items = await readdir(path);
  return items.length > 0;
}

async function buildInitConfig(parsed: ParsedArgs): Promise<InitConfig> {
  const nonInteractive = parsed.flags['no-interactive'] === true;
  const force = asBoolean(parsed.flags.force) ?? false;

  if (nonInteractive) {
    const installDir = resolveInstallDir(
      assertNonEmpty(mustGetStringFlag(parsed.flags, 'install-dir'), 'install-dir')
    );
    const host = assertNonEmpty(mustGetStringFlag(parsed.flags, 'host'), 'host');
    const port = parsePort(assertNonEmpty(mustGetStringFlag(parsed.flags, 'port'), 'port'));
    const databasePath = resolve(
      assertNonEmpty(mustGetStringFlag(parsed.flags, 'db-path'), 'db-path')
    );
    const autostart = mustGetBooleanFlag(parsed.flags, 'autostart');
    const serviceName = assertNonEmpty(
      asString(parsed.flags['service-name']) || DEFAULT_SERVICE_NAME,
      'service-name'
    );

    return {
      installDir,
      host,
      port,
      databasePath,
      autostart,
      serviceName,
      force,
      nonInteractive,
    };
  }

  const fallbackInstallDir = defaultInstallDir(process.platform);
  const installDirPrompt = await promptText(
    { nonInteractive: false },
    t('init.prompt.installDir'),
    asString(parsed.flags['install-dir']) || fallbackInstallDir
  );
  const installDir = resolveInstallDir(assertNonEmpty(installDirPrompt, 'install-dir'));

  const hostPrompt = await promptText(
    { nonInteractive: false },
    t('init.prompt.host'),
    asString(parsed.flags.host) || defaultHost()
  );
  const host = assertNonEmpty(hostPrompt, 'host');

  const portPrompt = await promptText(
    { nonInteractive: false },
    t('init.prompt.port'),
    asString(parsed.flags.port) || String(defaultPort())
  );
  const port = parsePort(assertNonEmpty(portPrompt, 'port'));

  const databasePathPrompt = await promptText(
    { nonInteractive: false },
    t('init.prompt.dbPath'),
    asString(parsed.flags['db-path']) || defaultDatabasePath(installDir)
  );
  const databasePath = resolve(assertNonEmpty(databasePathPrompt, 'db-path'));

  const autostart =
    asBoolean(parsed.flags.autostart) ??
    (await promptConfirm({ nonInteractive: false }, t('init.prompt.autostart'), true));

  const serviceNamePrompt = await promptText(
    { nonInteractive: false },
    t('init.prompt.serviceName'),
    asString(parsed.flags['service-name']) || DEFAULT_SERVICE_NAME
  );
  const serviceName = assertNonEmpty(serviceNamePrompt, 'service-name');

  return {
    installDir,
    host,
    port,
    databasePath,
    autostart,
    serviceName,
    force,
    nonInteractive,
  };
}

export async function runInit(parsed: ParsedArgs): Promise<void> {
  const config = await buildInitConfig(parsed);

  const bun = await checkBunVersion();
  if (!bun.ok || !bun.path) {
    throw new Error(bun.reason || t('bun.checkFailed'));
  }

  if (!config.force && (await directoryHasContent(config.installDir))) {
    if (config.nonInteractive) {
      throw new Error(t('init.error.installDirNotEmpty', { installDir: config.installDir }));
    }

    const confirmed = await promptConfirm(
      { nonInteractive: false },
      t('init.prompt.dirExistsConfirm', { installDir: config.installDir }),
      false
    );

    if (!confirmed) {
      throw new Error(t('common.cancelled'));
    }
  }

  const packageLayout = await resolvePackageLayout(import.meta.url);
  const installLayout = createInstallLayout(config.installDir);

  await ensureInstallDir(config.installDir, config.force);
  await ensureDir(dirname(config.databasePath));

  await deployRuntimeFiles(packageLayout, installLayout);

  const masterKey = generateMasterKey();
  const envValues = buildAppEnvValues({
    host: config.host,
    port: config.port,
    databasePath: config.databasePath,
    masterKey,
  });
  await writeEnvFile(installLayout.envPath, envValues);
  await writeRunScript(installLayout, bun.path);

  const manager = detectServiceManager();
  if (manager === 'none') {
    console.warn(`[tmex] ${t('init.warning.noServiceManager', { platform: process.platform })}`);
  } else {
    await installService({
      serviceName: config.serviceName,
      installDir: config.installDir,
      runScriptPath: installLayout.runScriptPath,
      autostart: config.autostart,
    });
  }

  const cliVersion = await readPackageVersion(packageLayout.packageRoot);
  const meta: InstallMeta = {
    serviceName: config.serviceName,
    platform: process.platform,
    autostart: config.autostart,
    installDir: config.installDir,
    updatedAt: new Date().toISOString(),
    cliVersion,
  };
  await writeInstallMeta(installLayout, meta);

  console.log(`[tmex] ${t('init.done')}`);
  console.log(`- ${t('init.summary.installDir')}: ${config.installDir}`);
  console.log(`- ${t('init.summary.serviceName')}: ${config.serviceName}`);
  console.log(`- ${t('init.summary.bun')}: ${bun.version} (${bun.path})`);
  console.log(
    `- ${t('init.summary.autostart')}: ${config.autostart ? t('init.summary.autostart.on') : t('init.summary.autostart.off')}`
  );
  if (manager !== 'none') {
    console.log(`- ${t('init.summary.serviceHint')}: ${serviceHint(config.serviceName)}`);
  }
}
