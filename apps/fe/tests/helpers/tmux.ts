import { execSync } from 'node:child_process';

export function tmux(cmd: string): string {
  return execSync(`tmux ${cmd}`, { encoding: 'utf8' }).trim();
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
