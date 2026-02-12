import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { t } from '../i18n';
import { ensureDir, pathExists, writeText } from './fs-utils';
import { type ServiceManagerKind, detectServiceManager } from './platform';
import { runCommand } from './process';

export interface ServiceInstallOptions {
  serviceName: string;
  runScriptPath: string;
  installDir: string;
  autostart: boolean;
}

export interface ServiceUninstallOptions {
  serviceName: string;
  installDir?: string;
}

export interface ServiceStatus {
  manager: ServiceManagerKind;
  installed: boolean;
  running: boolean;
  autostartEnabled: boolean;
  detail?: string;
}

function systemdUnitPath(serviceName: string): string {
  return join(homedir(), '.config', 'systemd', 'user', `${serviceName}.service`);
}

function launchdLabel(serviceName: string): string {
  return `com.tmex.${serviceName}`;
}

function launchdLaunchAgentsPlistPath(serviceName: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${launchdLabel(serviceName)}.plist`);
}

function launchdLocalPlistPath(serviceName: string, installDir: string): string {
  return join(installDir, `${launchdLabel(serviceName)}.plist`);
}

export function buildSystemdServiceContent({
  serviceName,
  runScriptPath,
  installDir,
}: ServiceInstallOptions): string {
  const escapedInstallDir = installDir.replaceAll('\\', '\\\\');
  const escapedRunScriptPath = runScriptPath.replaceAll('\\', '\\\\').replaceAll('"', '\\"');

  return `[Unit]
Description=tmex (${serviceName})
After=network.target

[Service]
Type=simple
WorkingDirectory=${escapedInstallDir}
SyslogIdentifier=tmex
StandardOutput=journal
StandardError=journal
ExecStart=/usr/bin/env bash "${escapedRunScriptPath}"
Restart=always
RestartSec=3
TimeoutStopSec=20

[Install]
WantedBy=default.target
`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function buildLaunchdPlist({
  serviceName,
  runScriptPath,
  installDir,
}: ServiceInstallOptions): string {
  const label = launchdLabel(serviceName);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${escapeXml(runScriptPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(installDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(installDir, 'tmex.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(installDir, 'tmex.err.log'))}</string>
</dict>
</plist>
`;
}

async function installSystemdService(options: ServiceInstallOptions): Promise<void> {
  const unitPath = systemdUnitPath(options.serviceName);
  await ensureDir(join(homedir(), '.config', 'systemd', 'user'));
  await writeText(unitPath, buildSystemdServiceContent(options));

  const daemonReload = await runCommand('systemctl', ['--user', 'daemon-reload']);
  if (daemonReload.code !== 0) {
    throw new Error(
      t('service.systemd.daemonReloadFailed', {
        detail: daemonReload.stderr || daemonReload.stdout,
      })
    );
  }

  if (options.autostart) {
    const enable = await runCommand('systemctl', ['--user', 'enable', options.serviceName]);
    if (enable.code !== 0) {
      throw new Error(
        t('service.systemd.enableFailed', {
          detail: enable.stderr || enable.stdout,
        })
      );
    }
  }

  const restart = await runCommand('systemctl', ['--user', 'restart', options.serviceName]);
  if (restart.code !== 0) {
    throw new Error(
      t('service.systemd.restartFailed', {
        detail: restart.stderr || restart.stdout,
      })
    );
  }
}

async function bootoutLaunchd(serviceName: string): Promise<void> {
  const uid = String(process.getuid?.() ?? 0);
  const plistPath = launchdLaunchAgentsPlistPath(serviceName);
  await runCommand('launchctl', ['bootout', `gui/${uid}`, plistPath]).catch(() => null);
}

async function installLaunchdService(options: ServiceInstallOptions): Promise<void> {
  const launchAgentsPath = launchdLaunchAgentsPlistPath(options.serviceName);
  const localPath = launchdLocalPlistPath(options.serviceName, options.installDir);
  const targetPath = options.autostart ? launchAgentsPath : localPath;

  if (options.autostart) {
    await ensureDir(join(homedir(), 'Library', 'LaunchAgents'));
  }

  await writeText(targetPath, buildLaunchdPlist(options));

  // Ensure no duplicate jobs in this user domain.
  await runCommand('launchctl', [
    'bootout',
    `gui/${process.getuid?.() ?? 0}`,
    launchAgentsPath,
  ]).catch(() => null);
  await runCommand('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}`, localPath]).catch(
    () => null
  );

  const uid = String(process.getuid?.() ?? 0);
  const bootstrap = await runCommand('launchctl', ['bootstrap', `gui/${uid}`, targetPath]);
  if (bootstrap.code !== 0) {
    throw new Error(
      t('service.launchd.bootstrapFailed', {
        detail: bootstrap.stderr || bootstrap.stdout,
      })
    );
  }
}

export async function installService(options: ServiceInstallOptions): Promise<void> {
  const manager = detectServiceManager();

  if (manager === 'systemd-user') {
    await installSystemdService(options);
    return;
  }

  if (manager === 'launchd') {
    await installLaunchdService(options);
    return;
  }

  throw new Error(t('service.install.unsupportedPlatform', { platform: process.platform }));
}

async function stopSystemd(serviceName: string): Promise<void> {
  await runCommand('systemctl', ['--user', 'stop', serviceName]).catch(() => null);
}

export async function stopService(serviceName: string, installDir?: string): Promise<void> {
  const manager = detectServiceManager();
  if (manager === 'systemd-user') {
    await stopSystemd(serviceName);
    return;
  }

  if (manager === 'launchd') {
    const uid = String(process.getuid?.() ?? 0);
    const launchAgentsPath = launchdLaunchAgentsPlistPath(serviceName);
    await runCommand('launchctl', ['bootout', `gui/${uid}`, launchAgentsPath]).catch(() => null);
    if (installDir) {
      const localPath = launchdLocalPlistPath(serviceName, installDir);
      await runCommand('launchctl', ['bootout', `gui/${uid}`, localPath]).catch(() => null);
    }
  }
}

async function startSystemd(serviceName: string, autostart: boolean): Promise<void> {
  const args = autostart
    ? ['--user', 'enable', '--now', serviceName]
    : ['--user', 'start', serviceName];
  const result = await runCommand('systemctl', args);
  if (result.code !== 0) {
    throw new Error(
      t('service.systemd.startRuntimeFailed', {
        detail: result.stderr || result.stdout,
      })
    );
  }
}

export async function startService(
  serviceName: string,
  autostart: boolean,
  installDir?: string
): Promise<void> {
  const manager = detectServiceManager();
  if (manager === 'systemd-user') {
    await startSystemd(serviceName, autostart);
    return;
  }

  if (manager === 'launchd') {
    const uid = String(process.getuid?.() ?? 0);
    const launchAgentsPath = launchdLaunchAgentsPlistPath(serviceName);
    const hasLaunchAgents = await pathExists(launchAgentsPath);

    const chosenPath = hasLaunchAgents
      ? launchAgentsPath
      : installDir
        ? launchdLocalPlistPath(serviceName, installDir)
        : launchAgentsPath;

    const bootstrap = await runCommand('launchctl', ['bootstrap', `gui/${uid}`, chosenPath]);
    if (bootstrap.code !== 0) {
      throw new Error(
        t('service.launchd.bootstrapFailed', {
          detail: bootstrap.stderr || bootstrap.stdout,
        })
      );
    }
    return;
  }
}

async function uninstallSystemdService(serviceName: string): Promise<void> {
  await runCommand('systemctl', ['--user', 'disable', '--now', serviceName]).catch(() => null);
  const unitPath = systemdUnitPath(serviceName);
  if (await pathExists(unitPath)) {
    await rm(unitPath, { force: true });
  }
  await runCommand('systemctl', ['--user', 'daemon-reload']).catch(() => null);
}

export async function uninstallService(options: ServiceUninstallOptions): Promise<void> {
  const manager = detectServiceManager();

  if (manager === 'systemd-user') {
    await uninstallSystemdService(options.serviceName);
    return;
  }

  if (manager === 'launchd') {
    const uid = String(process.getuid?.() ?? 0);
    const launchAgentsPath = launchdLaunchAgentsPlistPath(options.serviceName);
    await runCommand('launchctl', ['bootout', `gui/${uid}`, launchAgentsPath]).catch(() => null);
    await rm(launchAgentsPath, { force: true }).catch(() => null);

    if (options.installDir) {
      const localPath = launchdLocalPlistPath(options.serviceName, options.installDir);
      await runCommand('launchctl', ['bootout', `gui/${uid}`, localPath]).catch(() => null);
      await rm(localPath, { force: true }).catch(() => null);
    }
    return;
  }
}

async function querySystemdStatus(serviceName: string): Promise<ServiceStatus> {
  const unitPath = systemdUnitPath(serviceName);
  const installed = await pathExists(unitPath);

  const active = await runCommand('systemctl', ['--user', 'is-active', serviceName]).catch(
    () => null
  );
  const enabled = await runCommand('systemctl', ['--user', 'is-enabled', serviceName]).catch(
    () => null
  );

  return {
    manager: 'systemd-user',
    installed,
    running: active?.code === 0,
    autostartEnabled: enabled?.code === 0,
    detail: active?.stdout.trim() || enabled?.stdout.trim() || undefined,
  };
}

async function queryLaunchdStatus(
  serviceName: string,
  installDir?: string
): Promise<ServiceStatus> {
  const launchAgentsPath = launchdLaunchAgentsPlistPath(serviceName);
  const localPath = installDir ? launchdLocalPlistPath(serviceName, installDir) : null;
  const hasLaunchAgents = await pathExists(launchAgentsPath);
  const hasLocal = localPath ? await pathExists(localPath) : false;
  const installed = hasLaunchAgents || hasLocal;

  const uid = String(process.getuid?.() ?? 0);
  const label = launchdLabel(serviceName);
  const printed = await runCommand('launchctl', ['print', `gui/${uid}/${label}`]).catch(() => null);

  return {
    manager: 'launchd',
    installed,
    running: printed?.code === 0,
    autostartEnabled: hasLaunchAgents,
    detail: installed
      ? printed?.code === 0
        ? 'loaded'
        : (printed?.stderr || printed?.stdout || '').trim()
      : t('service.status.plistMissing'),
  };
}

export async function getServiceStatus(
  serviceName: string,
  installDir?: string
): Promise<ServiceStatus> {
  const manager = detectServiceManager();

  if (manager === 'systemd-user') {
    return await querySystemdStatus(serviceName);
  }

  if (manager === 'launchd') {
    return await queryLaunchdStatus(serviceName, installDir);
  }

  return {
    manager: 'none',
    installed: false,
    running: false,
    autostartEnabled: false,
    detail: t('service.status.none', { platform: process.platform }),
  };
}

export function serviceHint(serviceName: string): string {
  const manager = detectServiceManager();
  if (manager === 'systemd-user') {
    return t('service.hint.systemd', { serviceName });
  }
  if (manager === 'launchd') {
    return t('service.hint.launchd', { serviceName });
  }
  return t('service.hint.none');
}
