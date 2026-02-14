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

export function createTwoPaneSession(sessionName: string): { paneIds: string[] } {
  ensureCleanSession(sessionName);
  tmux(`new-session -d -s ${sessionName} "sh -lc 'echo PANE0_READY; exec sh'"`);
  tmux(`split-window -h -t ${sessionName} "sh -lc 'echo PANE1_READY; exec sh'"`);
  tmux(`select-pane -t ${sessionName}.0`);

  const paneIds = tmux(`list-panes -t ${sessionName} -F '#{pane_id}'`)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return { paneIds };
}

