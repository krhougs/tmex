import { t } from '../i18n';
import { checkBunVersion } from './bun';
import { detectLinuxDistro, detectPackageManager, type PackageManagerFamily } from './linux-distro';
import { runCommand } from './process';
import { promptConfirm } from './prompt';
import { checkTmuxVersion } from './tmux';

export type DepName = 'bun' | 'tmux';

export interface InstallCommand {
  label: string;
  command: string;
  requiresSudo: boolean;
  packageManager: string;
}

export interface DepInstallPlan {
  dep: DepName;
  commands: InstallCommand[];
  currentVersion?: string;
  requiredVersion: string;
  issue: 'missing' | 'version-too-low';
}

const TMUX_INSTALL_COMMANDS: Record<PackageManagerFamily, InstallCommand | null> = {
  brew: { label: 'Homebrew', command: 'brew install tmux', requiresSudo: false, packageManager: 'brew' },
  apt: { label: 'apt', command: 'apt install -y tmux', requiresSudo: true, packageManager: 'apt' },
  dnf: { label: 'dnf', command: 'dnf install -y tmux', requiresSudo: true, packageManager: 'dnf' },
  pacman: { label: 'pacman', command: 'pacman -S --noconfirm tmux', requiresSudo: true, packageManager: 'pacman' },
  apk: { label: 'apk', command: 'apk add tmux', requiresSudo: true, packageManager: 'apk' },
  zypper: { label: 'zypper', command: 'zypper install -y tmux', requiresSudo: true, packageManager: 'zypper' },
  unknown: null,
};

export function planBunInstall(): InstallCommand[] {
  return [
    {
      label: 'Official installer',
      command: 'curl -fsSL https://bun.sh/install | bash',
      requiresSudo: false,
      packageManager: 'curl',
    },
  ];
}

export async function planTmuxInstall(
  platform: NodeJS.Platform = process.platform
): Promise<InstallCommand[]> {
  if (platform === 'darwin') {
    const brewAvailable = await isCommandAvailable('brew');
    if (!brewAvailable) return [];
    return [TMUX_INSTALL_COMMANDS.brew!];
  }

  if (platform === 'linux') {
    const distro = await detectLinuxDistro();
    const pm = detectPackageManager(distro, platform);
    const cmd = TMUX_INSTALL_COMMANDS[pm];
    if (cmd) return [cmd];
    return [];
  }

  return [];
}

export function getInstallHint(dep: DepName, platform: NodeJS.Platform = process.platform): string {
  if (dep === 'bun') {
    return 'curl -fsSL https://bun.sh/install | bash';
  }

  if (platform === 'darwin') {
    return 'brew install tmux';
  }

  return 'apt/dnf/pacman/apk install tmux';
}

export async function getInstallHintAsync(
  dep: DepName,
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  if (dep === 'bun') {
    return 'curl -fsSL https://bun.sh/install | bash';
  }

  if (platform === 'darwin') {
    return 'brew install tmux';
  }

  if (platform === 'linux') {
    const distro = await detectLinuxDistro();
    const pm = detectPackageManager(distro, platform);
    const cmd = TMUX_INSTALL_COMMANDS[pm];
    if (cmd) {
      const prefix = cmd.requiresSudo ? 'sudo ' : '';
      return `${prefix}${cmd.command}`;
    }
  }

  return 'apt/dnf/pacman/apk install tmux';
}

async function isCommandAvailable(command: string): Promise<boolean> {
  const result = await runCommand(command, ['--version'], {
    stdio: 'pipe',
    timeoutMs: 5000,
  }).catch(() => null);
  return result !== null && result.code === 0;
}

export function isRoot(): boolean {
  return process.getuid?.() === 0;
}

export async function isSudoAvailable(): Promise<boolean> {
  const result = await runCommand('sudo', ['-n', 'true'], {
    stdio: 'pipe',
    timeoutMs: 5000,
  }).catch(() => null);
  return result !== null && result.code === 0;
}

function resolveCommand(cmd: InstallCommand): string {
  if (!cmd.requiresSudo) return cmd.command;
  if (isRoot()) return cmd.command;
  return `sudo ${cmd.command}`;
}

export async function executeDependencyInstall(
  plan: DepInstallPlan,
  options: { nonInteractive: boolean; autoConfirm: boolean }
): Promise<boolean> {
  if (plan.commands.length === 0) {
    if (plan.dep === 'tmux' && process.platform === 'darwin') {
      console.error(`[tmex] ${t('deps.install.brewMissing')}`);
    } else {
      console.error(`[tmex] ${t('deps.install.unknownDistro', { dep: plan.dep })}`);
    }
    console.error(`[tmex] ${t('deps.install.manual')}`);
    return false;
  }

  const cmd = plan.commands[0]!;
  const fullCommand = resolveCommand(cmd);

  if (cmd.requiresSudo && !isRoot()) {
    if (options.nonInteractive) {
      const sudoOk = await isSudoAvailable();
      if (!sudoOk) {
        console.error(`[tmex] ${t('deps.install.sudoUnavailable')}`);
        return false;
      }
    }
  }

  console.log(`[tmex] ${t('deps.install.hint', { command: fullCommand })}`);

  if (!options.autoConfirm) {
    if (options.nonInteractive) {
      console.error(`[tmex] ${t('deps.install.nonInteractive', { dep: plan.dep })}`);
      return false;
    }

    const confirmed = await promptConfirm(
      { nonInteractive: false },
      t('deps.install.confirm', { dep: plan.dep }),
      true
    );
    if (!confirmed) return false;
  }

  console.log(`[tmex] ${t('deps.install.running', { dep: plan.dep })}`);

  const parts = fullCommand.split(' ');
  const bin = parts[0]!;
  const args = parts.slice(1);

  if (fullCommand.includes('|')) {
    const result = await runCommand('sh', ['-c', fullCommand], { stdio: 'inherit' }).catch(() => null);
    if (!result || result.code !== 0) {
      console.error(`[tmex] ${t('deps.install.failed', { dep: plan.dep })}`);
      console.error(`[tmex] ${t('deps.install.manual')}`);
      return false;
    }
  } else {
    const result = await runCommand(bin, args, { stdio: 'inherit' }).catch(() => null);
    if (!result || result.code !== 0) {
      console.error(`[tmex] ${t('deps.install.failed', { dep: plan.dep })}`);
      console.error(`[tmex] ${t('deps.install.manual')}`);
      return false;
    }
  }

  if (plan.dep === 'bun') {
    const check = await checkBunVersion();
    if (check.ok) {
      console.log(`[tmex] ${t('deps.install.success', { dep: plan.dep })}`);
      return true;
    }
  } else {
    const check = await checkTmuxVersion();
    if (check.ok) {
      console.log(`[tmex] ${t('deps.install.success', { dep: plan.dep })}`);
      return true;
    }
  }

  console.error(`[tmex] ${t('deps.install.failed', { dep: plan.dep })}`);
  console.error(`[tmex] ${t('deps.install.manual')}`);
  return false;
}
