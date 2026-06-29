import { describe, expect, test } from 'bun:test';
import { getInstallHint, isRoot, planBunInstall, planTmuxInstall } from './dep-install';

describe('planBunInstall', () => {
  test('returns official installer command', () => {
    const commands = planBunInstall();
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toBe('curl -fsSL https://bun.sh/install | bash');
    expect(commands[0]!.requiresSudo).toBe(false);
    expect(commands[0]!.packageManager).toBe('curl');
  });
});

describe('planTmuxInstall', () => {
  test('returns brew command on macOS', async () => {
    const commands = await planTmuxInstall('darwin');
    // On macOS dev machine, brew should be available
    if (commands.length > 0) {
      expect(commands[0]!.command).toBe('brew install tmux');
      expect(commands[0]!.requiresSudo).toBe(false);
      expect(commands[0]!.packageManager).toBe('brew');
    }
  });

  test('returns empty for unsupported platforms', async () => {
    const commands = await planTmuxInstall('win32' as NodeJS.Platform);
    expect(commands).toHaveLength(0);
  });
});

describe('getInstallHint', () => {
  test('returns bun install command for bun', () => {
    expect(getInstallHint('bun')).toBe('curl -fsSL https://bun.sh/install | bash');
    expect(getInstallHint('bun', 'linux')).toBe('curl -fsSL https://bun.sh/install | bash');
    expect(getInstallHint('bun', 'darwin')).toBe('curl -fsSL https://bun.sh/install | bash');
  });

  test('returns brew for tmux on macOS', () => {
    expect(getInstallHint('tmux', 'darwin')).toBe('brew install tmux');
  });

  test('returns generic command for tmux on linux', () => {
    expect(getInstallHint('tmux', 'linux')).toBe('apt/dnf/pacman/apk install tmux');
  });
});

describe('isRoot', () => {
  test('returns false for normal user', () => {
    expect(isRoot()).toBe(false);
  });
});
