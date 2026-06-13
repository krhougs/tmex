// 采集「入口主机」环境事实，注入 system prompt。
// 注意：local 设备的 gateway 进程即入口主机，可读 os/shell；ssh 设备只知接入参数，
// 远端真实环境未知（pane 可能进一步 ssh 到别处），由 prompt 引导 agent 自行探测。

import os from 'node:os';
import type { Device } from '@tmex/shared';

export interface AgentEnvironmentInfo {
  deviceName: string | null;
  deviceType: 'local' | 'ssh' | null;
  host: string | null;
  username: string | null;
  port: number | null;
  tmuxSession: string | null;
  timezone: string;
  nowIso: string;
  /** 仅 local 设备可知：gateway 主机即入口主机 */
  gatewayOs: string | null;
  gatewayShell: string | null;
}

export function collectAgentEnvironment(device: Device | null): AgentEnvironmentInfo {
  const isLocal = device?.type === 'local';
  let timezone = 'UTC';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  } catch {
    timezone = 'UTC';
  }
  return {
    deviceName: device?.name ?? null,
    deviceType: device?.type ?? null,
    host: device?.host ?? null,
    username: device?.username ?? null,
    port: device?.port ?? null,
    tmuxSession: device?.session ?? null,
    timezone,
    nowIso: new Date().toISOString(),
    gatewayOs: isLocal ? `${os.platform()} ${os.release()} (${os.arch()})` : null,
    gatewayShell: isLocal ? (process.env.SHELL ?? null) : null,
  };
}
