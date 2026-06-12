// tmux target（pane/window）缺失的统一判定与静默错误形态。
// 主动采样场景（Agent read_screen / Watch 周期采样）里 pane 消失属于预期内情况，
// 抛出 TmuxTargetMissingError 让调用方自行处理，不触发连接级告警、不污染设备运行状态。

export class TmuxTargetMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TmuxTargetMissingError';
  }
}

export function isTargetMissingMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("can't find window") ||
    normalized.includes("can't find pane") ||
    normalized.includes('no such window') ||
    normalized.includes('no such pane')
  );
}

export function isTmuxTargetMissingError(error: unknown): error is TmuxTargetMissingError {
  return error instanceof TmuxTargetMissingError;
}
