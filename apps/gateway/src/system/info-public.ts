/**
 * 系统信息公共面：不依赖 update-check / upgrade 模块，可供 managed 与开源路径共用。
 */
import {
  PASTE_IMAGE_MAX_BYTES,
  TERMINAL_PASTE_MAX_BYTES,
  type SystemInfo,
} from '@tmex/shared';
import { config } from '../config';
import { getInstallInfo } from './install-info';
import {
  canSelfUpdate as canSelfUpdateManaged,
  getManagementMode,
  getUpdateOwner,
} from './managed';
import { getBaseVersion, getDisplayVersion } from './version';

export { getBaseVersion, getDisplayVersion } from './version';
export { getInstallInfo } from './install-info';
export {
  canSelfUpdate,
  getManagementMode,
  getUpdateOwner,
  isManagedExternally,
  lockManagedRuntime,
  MANAGED_EXTERNALLY,
  resetManagedRuntimeForTests,
} from './managed';

/** 汇总系统信息（设置页版本 section 的权威来源） */
export function getSystemInfo(): SystemInfo {
  const install = getInstallInfo();
  const canSelfUpdate =
    canSelfUpdateManaged(install.installedViaCli && install.deployment !== 'none', config.isProd) &&
    getManagementMode() === 'none';

  return {
    version: getDisplayVersion(),
    baseVersion: getBaseVersion(),
    isProd: config.isProd,
    installedViaCli: install.installedViaCli,
    deployment: install.deployment,
    canSelfUpdate,
    serviceName: install.serviceName,
    transferMaxBytes: config.transferMaxBytes,
    terminalPasteMaxBytes: TERMINAL_PASTE_MAX_BYTES,
    pasteImageMaxBytes: PASTE_IMAGE_MAX_BYTES,
    managementMode: getManagementMode(),
    updateOwner: getUpdateOwner(),
  };
}
