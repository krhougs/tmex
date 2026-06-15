import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GatewayDeployment } from '@tmex/shared';
import { config } from '../config';

/** install-meta.json 形状（由 tmex-cli init/upgrade 写入） */
export interface InstallMetaShape {
  serviceName?: string;
  platform?: string;
  autostart?: boolean;
  installDir?: string;
  updatedAt?: string;
  cliVersion?: string;
  bunPath?: string;
}

export interface InstallInfo {
  installedViaCli: boolean;
  deployment: GatewayDeployment;
  installDir: string | null;
  serviceName: string | null;
  cliVersion: string | null;
  bunPath: string | null;
}

/**
 * 反推安装目录：优先由 run.sh export 的 TMEX_FE_DIST_DIR
 * （= installDir/resources/fe-dist）上溯两级，回退到 cwd（服务 WorkingDirectory=installDir）。
 */
export function resolveInstallDir(): string {
  const feDist = process.env.TMEX_FE_DIST_DIR;
  if (feDist) {
    return resolve(feDist, '..', '..');
  }
  return process.cwd();
}

export function readInstallMeta(): InstallMetaShape | null {
  const metaPath = resolve(resolveInstallDir(), 'install-meta.json');
  try {
    if (!existsSync(metaPath)) return null;
    return JSON.parse(readFileSync(metaPath, 'utf8')) as InstallMetaShape;
  } catch {
    return null;
  }
}

function deploymentFromPlatform(platform: string | undefined): GatewayDeployment {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') return 'systemd';
  return 'none';
}

/**
 * 判定安装方式。仅 production 才可能存在 CLI 安装产物（install-meta.json）；
 * dev/test 一律视为非 CLI（自更新本就在非 production 禁用）。
 * production 下无 install-meta（docker / 手动部署）→ 非 CLI 安装。
 */
export function getInstallInfo(): InstallInfo {
  if (!config.isProd) {
    return {
      installedViaCli: false,
      deployment: 'none',
      installDir: null,
      serviceName: null,
      cliVersion: null,
      bunPath: null,
    };
  }

  const meta = readInstallMeta();
  if (!meta) {
    return {
      installedViaCli: false,
      deployment: 'none',
      installDir: resolveInstallDir(),
      serviceName: null,
      cliVersion: null,
      bunPath: null,
    };
  }

  return {
    installedViaCli: true,
    deployment: deploymentFromPlatform(meta.platform ?? process.platform),
    installDir: meta.installDir ?? resolveInstallDir(),
    serviceName: meta.serviceName ?? null,
    cliVersion: meta.cliVersion ?? null,
    bunPath: meta.bunPath ?? null,
  };
}
