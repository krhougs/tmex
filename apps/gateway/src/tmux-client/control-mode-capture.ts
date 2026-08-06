import type { PaneModeFlags } from '@tmex/shared';
import type { ControlModeBlock } from './control-mode-parser';
import { isTmuxPaneId } from './snapshot-format';

export interface AtomicPaneCapture {
  // 可见区（-S 0 起）；历史段单独采集，避免 -J 把跨越 history/可见区边界的
  // 折行合并成一行导致可见区行数漂移、绝对光标恢复错位。
  text: string;
  // 纯历史段（-S -N -E -1）；未请求历史时为 null。alt 屏或 history_size=0 时
  // tmux 会退化返回可见区首行，消费方必须结合同屏障的 alternate_on/history_size 门控。
  historyText: string | null;
  cols: number;
  rows: number;
  cursorX: number | null;
  cursorY: number | null;
  alternateScreen: boolean;
  historySize: number;
  // capture-pane 文本不含 DECSET 序列，鼠标模式唯一权威来源是 tmux 的 format 变量，
  // 必须与截屏在同一 control 屏障内读取；null 表示该连接采不到（快照将不声明模式位图）。
  modes: PaneModeFlags | null;
}

interface PendingControlCommand<T = unknown> {
  command: string;
  literal: boolean;
  timeoutMs: number;
  transform: (block: ControlModeBlock) => T;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  // 超时已单独 reject,但块尚未到达:占位保持 FIFO 对位,迟到块到达时丢弃。
  settled: boolean;
}

// 队头超时 reject 后,再给迟到块的宽限;仍无块说明流已停滞,才毒化整条连接。
const STALLED_STREAM_TIMEOUT_MS = 20_000;

export class ControlModeCommandQueue {
  private readonly pending: PendingControlCommand[] = [];
  private poisoned = false;

  constructor(
    private readonly onPoison?: () => void,
    private readonly stalledTimeoutMs = STALLED_STREAM_TIMEOUT_MS
  ) {}

  execute<T>(
    write: (command: string) => void,
    command: string,
    options: {
      literal?: boolean;
      timeoutMs?: number;
      transform: (block: ControlModeBlock) => T;
    }
  ): Promise<T> {
    if (this.poisoned) return Promise.reject(new Error('tmux control command queue is closed'));
    return new Promise<T>((resolve, reject) => {
      const pending: PendingControlCommand<T> = {
        command,
        literal: options.literal ?? false,
        timeoutMs: options.timeoutMs ?? 10_000,
        transform: options.transform,
        resolve,
        reject,
        timer: null,
        settled: false,
      };
      this.pending.push(pending as PendingControlCommand);
      this.armHeadTimeout();
      try {
        write(command.endsWith('\n') ? command : `${command}\n`);
      } catch (error) {
        this.poison(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  nextBlockIsLiteral(): boolean {
    return this.pending[0]?.literal ?? false;
  }

  handleBlock(block: ControlModeBlock): boolean {
    const pending = this.pending.shift();
    if (!pending) return false;
    if (pending.timer !== null) clearTimeout(pending.timer);
    this.armHeadTimeout();
    // 迟到块:命令已按超时 reject,这里只消耗块保持 FIFO 对位。
    if (pending.settled) return true;
    if (block.isError) {
      pending.reject(new Error(block.lines.join('\n') || 'tmux control command failed'));
      return true;
    }
    try {
      pending.resolve(pending.transform(block));
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  }

  dispose(reason = 'tmux control command queue closed'): void {
    if (this.poisoned) return;
    this.poisoned = true;
    const error = new Error(reason);
    for (const pending of this.pending.splice(0)) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private armHeadTimeout(): void {
    const pending = this.pending[0];
    if (this.poisoned || !pending || pending.timer !== null) return;
    pending.timer = setTimeout(() => {
      if (this.pending[0] !== pending) return;
      // 单条超时只 fail 该命令,不杀连接:输出洪流(如 alt 屏 TUI 重绘)下响应
      // 只是排队慢,毒化-重连反而形成风暴。占位保持 FIFO 对位,迟到块到达时
      // 丢弃;宽限后仍无块才判定流停滞、毒化重连。
      pending.settled = true;
      pending.reject(
        new Error(`tmux control command timed out: ${pending.command.slice(0, 80)}`)
      );
      pending.timer = setTimeout(() => {
        if (this.pending[0] !== pending) return;
        this.poison(
          new Error(`tmux control stream stalled: ${pending.command.slice(0, 80)}`)
        );
      }, this.stalledTimeoutMs);
    }, pending.timeoutMs);
  }

  private poison(error: Error): void {
    if (this.poisoned) return;
    this.poisoned = true;
    for (const pending of this.pending.splice(0)) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.onPoison?.();
  }
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parsePaneFrameInfo(block: ControlModeBlock): Omit<AtomicPaneCapture, 'text'> {
  const info = block.lines[0]?.split('|');
  const cols = parseNonNegativeInteger(info?.[0]);
  const rows = parseNonNegativeInteger(info?.[1]);
  if (cols === null || rows === null || cols < 1 || rows < 1) {
    throw new Error('invalid tmux pane frame info');
  }
  return {
    cols,
    rows,
    alternateScreen: info?.[2] === '1',
    cursorX: parseNonNegativeInteger(info?.[3]),
    cursorY: parseNonNegativeInteger(info?.[4]),
    historySize: parseNonNegativeInteger(info?.[5]) ?? 0,
    modes: {
      mouseStandard: info?.[6] === '1',
      mouseButton: info?.[7] === '1',
      mouseAll: info?.[8] === '1',
      mouseSgr: info?.[9] === '1',
      mouseUtf8: info?.[10] === '1',
    },
  };
}

export async function capturePaneFrameAtControlBarrier(
  queue: ControlModeCommandQueue,
  write: (command: string) => void,
  paneId: string,
  historyLines: number,
  onBarrier: () => void,
  timeoutMs = 10_000
): Promise<AtomicPaneCapture> {
  if (!isTmuxPaneId(paneId)) throw new Error(`invalid tmux pane id: ${paneId}`);
  const boundedHistoryLines = Math.max(0, Math.min(4096, Math.floor(historyLines)));
  const infoPromise = queue.execute(write, `display-message -p -t ${paneId} "#{pane_width}|#{pane_height}|#{alternate_on}|#{cursor_x}|#{cursor_y}|#{history_size}|#{mouse_standard_flag}|#{mouse_button_flag}|#{mouse_all_flag}|#{mouse_sgr_flag}|#{mouse_utf8_flag}"`, {
    timeoutMs,
    transform: parsePaneFrameInfo,
  });
  const visibleArgs = ['capture-pane', '-p', '-e', '-J', '-N', '-t', paneId];
  const textPromise = queue.execute(write, visibleArgs.join(' '), {
    literal: true,
    timeoutMs,
    transform: (block) => {
      onBarrier();
      // 不补行尾换行：整屏快照写进终端时，末行多一个换行会把首行顶出屏幕，
      // 随后按绝对坐标恢复的光标就会落在错位一行的内容上。
      return block.lines.join('\n');
    },
  });
  // 历史段延迟到 info 返回后条件入队:alt 屏或零历史时 tmux 会退化返回可见区
  // 首行(纯浪费,还在 TUI 重绘洪流下加重队列排队)。代价是历史段脱离了可见区
  // 的屏障:间隙内新输出可能把可见区首行推进历史,join 端至多重复一行,消费方
  // 本就按 history_size 门控。
  const historyPromise =
    boundedHistoryLines > 0
      ? infoPromise.then((info) =>
          info.alternateScreen || info.historySize === 0
            ? null
            : queue.execute(
                write,
                [...visibleArgs, '-S', `-${boundedHistoryLines}`, '-E', '-1'].join(' '),
                {
                  literal: true,
                  timeoutMs,
                  transform: (block) => block.lines.join('\n'),
                }
              )
        )
      : Promise.resolve(null);
  const [info, text, historyText] = await Promise.all([infoPromise, textPromise, historyPromise]);
  return { ...info, text, historyText };
}
