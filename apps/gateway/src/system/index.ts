import type { SystemInfo } from '@tmex/shared';
import { config } from '../config';
import { getInstallInfo } from './install-info';
import { getBaseVersion, getDisplayVersion } from './version';

export { getBaseVersion, getDisplayVersion } from './version';
export { getInstallInfo } from './install-info';
export { checkForUpdate } from './update-check';
export { upgradeController } from './upgrade';

/** 汇总系统信息（设置页版本 section 的权威来源） */
export function getSystemInfo(): SystemInfo {
  const install = getInstallInfo();
  const canSelfUpdate = config.isProd && install.installedViaCli && install.deployment !== 'none';

  return {
    version: getDisplayVersion(),
    baseVersion: getBaseVersion(),
    isProd: config.isProd,
    installedViaCli: install.installedViaCli,
    deployment: install.deployment,
    canSelfUpdate,
    serviceName: install.serviceName,
  };
}
