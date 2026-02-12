import { rm } from 'node:fs/promises';
import { defaultInstallDir } from '../constants';
import { t } from '../i18n';
import { readEnvFile } from '../lib/env-file';
import { pathExists, resolvePath } from '../lib/fs-utils';
import { createInstallLayout, resolveInstallDir } from '../lib/install-layout';
import { readJsonFile } from '../lib/json-file';
import { promptConfirm } from '../lib/prompt';
import { uninstallService } from '../lib/service';
import { asBoolean, asString } from '../lib/validate';
import type { InstallMeta, ParsedArgs } from '../types';

async function removeIfExists(path: string): Promise<void> {
  if (await pathExists(path)) {
    await rm(path, { recursive: true, force: true });
  }
}

export async function runUninstall(parsed: ParsedArgs): Promise<void> {
  const installDir = resolveInstallDir(
    asString(parsed.flags['install-dir']) || defaultInstallDir(process.platform)
  );
  const installLayout = createInstallLayout(installDir);
  const yes = asBoolean(parsed.flags.yes) ?? false;
  const purge = asBoolean(parsed.flags.purge) ?? false;

  let serviceName = asString(parsed.flags['service-name']) || 'tmex';
  if (await pathExists(installLayout.metaPath)) {
    const meta = await readJsonFile<InstallMeta>(installLayout.metaPath);
    serviceName = meta.serviceName;
  }

  const ask = async (message: string, defaultValue: boolean): Promise<boolean> => {
    if (yes) return defaultValue;
    return await promptConfirm({ nonInteractive: false }, message, defaultValue);
  };

  const removeService = await ask(t('uninstall.prompt.removeService'), true);
  const removeProgram = await ask(t('uninstall.prompt.removeProgram'), true);
  const removeEnv = await ask(t('uninstall.prompt.removeEnv'), purge);
  const removeDatabase = await ask(t('uninstall.prompt.removeDatabase'), purge);

  let databasePath: string | undefined;
  if (await pathExists(installLayout.envPath)) {
    const env = await readEnvFile(installLayout.envPath).catch(
      () => ({}) as Record<string, string>
    );
    databasePath = env.DATABASE_URL;
  }

  if (removeService) {
    await uninstallService({ serviceName, installDir });
  }

  if (removeProgram) {
    await removeIfExists(installLayout.runtimeDir);
    await removeIfExists(installLayout.resourcesDir);
    await removeIfExists(installLayout.runScriptPath);
    await removeIfExists(installLayout.metaPath);
  }

  if (removeEnv) {
    await removeIfExists(installLayout.envPath);
  }

  if (removeDatabase) {
    if (databasePath) {
      await removeIfExists(resolvePath(databasePath));
    }
  }

  if (purge) {
    await removeIfExists(installLayout.installDir);
  }

  console.log(`[tmex] ${t('uninstall.done')}`);
  console.log(`- ${t('uninstall.summary.installDir')}: ${installLayout.installDir}`);
  console.log(`- ${t('uninstall.summary.serviceName')}: ${serviceName}`);
}
