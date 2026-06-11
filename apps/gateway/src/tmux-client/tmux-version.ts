// control mode 订阅所需的核心通知（%output / %window-add / %layout-change 等）自 3.0 起齐备。
export const MIN_CONTROL_MODE_VERSION = { major: 3, minor: 0 };

export interface TmuxVersion {
  major: number;
  minor: number;
}

// 解析 `tmux -V` 输出，如 "tmux 3.4" / "tmux 3.3a" / "tmux next-3.6"。
// master/openbsd 等无数字版本返回 null，调用方应放行。
export function parseTmuxVersion(versionOutput: string): TmuxVersion | null {
  const match = versionOutput.match(/(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1] as string, 10),
    minor: Number.parseInt(match[2] as string, 10),
  };
}

export function isControlModeSupported(version: TmuxVersion | null): boolean {
  if (!version) {
    return true;
  }
  if (version.major !== MIN_CONTROL_MODE_VERSION.major) {
    return version.major > MIN_CONTROL_MODE_VERSION.major;
  }
  return version.minor >= MIN_CONTROL_MODE_VERSION.minor;
}
