import { execSync } from 'node:child_process';

// e2e 专用 tmux socket，与生产/开发默认 socket（/private/tmp/tmux-501/default）隔离，
// 避免 e2e 的会话 create/destroy 影响本机常驻 tmex。必须与 playwright.config.ts 注入给
// 被测 gateway 的 TMEX_TMUX_SOCKET 保持一致，否则 gateway 在默认 socket 上找不到会话。
export const E2E_TMUX_SOCKET = 'tmex-e2e';

export function tmux(cmd: string): string {
  return execSync(`tmux -L ${E2E_TMUX_SOCKET} ${cmd}`, { encoding: 'utf8' }).trim();
}

export function ensureCleanSession(sessionName: string): void {
  try {
    tmux(`kill-session -t ${sessionName}`);
  } catch {
    // ignore
  }
}

export function createTwoPaneSession(sessionName: string): { paneIds: string[]; windowId: string } {
  ensureCleanSession(sessionName);
  tmux(`new-session -d -s ${sessionName} "sh -lc 'echo PANE0_READY; exec sh'"`);
  tmux(`split-window -h -t ${sessionName} "sh -lc 'echo PANE1_READY; exec sh'"`);
  tmux(`select-pane -t ${sessionName}.0`);

  const paneIds = tmux(`list-panes -t ${sessionName} -F '#{pane_id}'`)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const windowId = tmux(`display-message -p -t ${sessionName}:0 '#{window_id}'`);

  return { paneIds, windowId };
}

export function getPaneSize(paneId: string): { cols: number; rows: number } {
  const [colsRaw, rowsRaw] = tmux(`display-message -p -t ${paneId} '#{pane_width}\t#{pane_height}'`)
    .split('\t')
    .map((value) => value.trim());

  return {
    cols: Number.parseInt(colsRaw ?? '0', 10),
    rows: Number.parseInt(rowsRaw ?? '0', 10),
  };
}
