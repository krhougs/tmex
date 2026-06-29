import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device, FileErrorCode } from '@tmex/shared';
import { decryptWithContext } from '../crypto';
import { quoteShellArg } from '../tmux-client/command-builder';
import { resolveSshConnectConfig } from '../tmux-client/ssh-connect-config';

export class RsyncAuthError extends Error {
  code: FileErrorCode;
  constructor(code: FileErrorCode, message: string) {
    super(message);
    this.name = 'RsyncAuthError';
    this.code = code;
  }
}

export interface RsyncDeviceSpec {
  // ssh 目标前缀：local 设备为 ''（直接用本地路径）；ssh 为 'user@host:'
  targetPrefix: string;
  // rsync 的 -e 值（ssh 命令串，按空格切分，故各 token 不能含空格）；local 为 undefined
  rsh: string | undefined;
  // 额外环境变量（如 SSH_AUTH_SOCK / SSH_ASKPASS 链路）
  env: Record<string, string>;
  cleanup: () => void;
}

// 基础 ssh 选项（不含 BatchMode：密码/passphrase 走 SSH_ASKPASS 时必须允许交互式提示）
const SSH_BASE_OPTS = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10'];

// 用 SSH_ASKPASS 非交互地回答密码/passphrase 提示（OpenSSH 8.4+ 的 SSH_ASKPASS_REQUIRE=force）。
// 临时 askpass 脚本本身不含密钥，密钥经环境变量传入；脚本 0700，用后清理。
function setupAskpass(secret: string): { env: Record<string, string>; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'tmex-rsync-ap-'));
  const scriptPath = join(dir, 'askpass.sh');
  writeFileSync(scriptPath, '#!/bin/sh\nprintf \'%s\\n\' "$TMEX_RSYNC_SECRET"\n', { mode: 0o700 });
  chmodSync(scriptPath, 0o700);
  return {
    env: {
      SSH_ASKPASS: scriptPath,
      SSH_ASKPASS_REQUIRE: 'force',
      TMEX_RSYNC_SECRET: secret,
      // 老版 ssh 在无 tty 时需要 DISPLAY 才会调用 askpass；新版靠 REQUIRE=force 即可
      DISPLAY: process.env.DISPLAY || ':0',
    },
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 已删
      }
    },
  };
}

function writeTempKey(privateKey: string): { keyPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'tmex-rsync-key-'));
  const keyPath = join(dir, 'id');
  writeFileSync(keyPath, privateKey, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  return {
    keyPath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 已删
      }
    },
  };
}

// 为某设备构造 rsync 的传输规格。local→直接本地路径；ssh→构造 -e ssh + user@host: 前缀。
// resolveConfig 可注入以便单测（默认走真实 resolveSshConnectConfig）。
export async function buildRsyncDeviceSpec(
  device: Device,
  decrypt: typeof decryptWithContext = decryptWithContext,
  resolveConfig: typeof resolveSshConnectConfig = resolveSshConnectConfig
): Promise<RsyncDeviceSpec> {
  if (device.type === 'local') {
    return { targetPrefix: '', rsh: undefined, env: {}, cleanup: () => {} };
  }

  // configRef：直接用别名让 ssh 读 ~/.ssh/config（最忠实，支持 ProxyJump 等）
  if (device.authMode === 'configRef' && device.sshConfigRef?.trim()) {
    const alias = device.sshConfigRef.trim();
    return {
      targetPrefix: `${alias}:`,
      rsh: ['ssh', ...SSH_BASE_OPTS, '-o', 'BatchMode=yes'].join(' '),
      env: {},
      cleanup: () => {},
    };
  }

  const cfg = await resolveConfig(device, decrypt);
  if (!cfg.host) {
    throw new RsyncAuthError('connection_failed', 'SSH 设备缺少 host');
  }
  const port = cfg.port ?? 22;
  const target = cfg.username ? `${cfg.username}@${cfg.host}` : cfg.host;
  const sshArgs = ['ssh', '-p', String(port), ...SSH_BASE_OPTS];
  const env: Record<string, string> = {};
  const cleanups: Array<() => void> = [];

  if (cfg.privateKey) {
    const { keyPath, cleanup } = writeTempKey(String(cfg.privateKey));
    sshArgs.push('-i', keyPath, '-o', 'IdentitiesOnly=yes');
    cleanups.push(cleanup);
    if (cfg.agent) {
      // 兼有 ssh-agent，可解 passphrase 私钥；非交互
      env.SSH_AUTH_SOCK = String(cfg.agent);
      sshArgs.push('-o', 'BatchMode=yes');
    } else if (cfg.passphrase) {
      // passphrase 私钥：用 askpass 回答 passphrase 提示
      const ap = setupAskpass(String(cfg.passphrase));
      Object.assign(env, ap.env);
      cleanups.push(ap.cleanup);
    } else {
      sshArgs.push('-o', 'BatchMode=yes');
    }
  } else if (cfg.agent) {
    env.SSH_AUTH_SOCK = String(cfg.agent);
    sshArgs.push('-o', 'BatchMode=yes');
  } else if (cfg.password) {
    // 密码认证：用 askpass 回答 password / keyboard-interactive 提示
    const ap = setupAskpass(String(cfg.password));
    Object.assign(env, ap.env);
    cleanups.push(ap.cleanup);
    sshArgs.push(
      '-o',
      'PreferredAuthentications=password,keyboard-interactive',
      '-o',
      'NumberOfPasswordPrompts=1'
    );
  } else {
    throw new RsyncAuthError(
      'auth_unsupported',
      '未找到可用于 rsync 的认证方式（密钥 / ssh-agent / 密码）'
    );
  }

  return {
    targetPrefix: `${target}:`,
    rsh: sshArgs.join(' '),
    env,
    cleanup: () => {
      for (const c of cleanups) c();
    },
  };
}

// 构造 rsync 的目标参数：local 直接用路径；ssh 用 prefix + 单引号包裹的远端路径（防远端 shell 切分）
export function rsyncTargetArg(spec: RsyncDeviceSpec, remotePath: string): string {
  if (!spec.targetPrefix) return remotePath;
  return `${spec.targetPrefix}${quoteShellArg(remotePath)}`;
}

// rsync argv：list-only / 拷贝。spec.rsh 存在时插入 -e。
export function rsyncListArgs(spec: RsyncDeviceSpec, remotePath: string): string[] {
  const args = ['--list-only', '--8-bit-output'];
  if (spec.rsh) args.push('-e', spec.rsh);
  args.push(rsyncTargetArg(spec, remotePath));
  return args;
}

export function rsyncCopyArgs(spec: RsyncDeviceSpec, remotePath: string, dest: string): string[] {
  // -L：跟随符号链接，拷贝链接目标内容（否则只拷贝链接本身）
  // --progress：openrsync 与 GNU rsync 共有，按文件输出进度行（单文件传输即整体进度）
  const args = ['-L', '--progress'];
  if (spec.rsh) args.push('-e', spec.rsh);
  args.push(rsyncTargetArg(spec, remotePath), dest);
  return args;
}

// 反向上传：本机源 → 设备目标。与 rsyncCopyArgs 对称地调换源/目标；本机源是真实临时文件，无需 -L。
export function rsyncUploadArgs(
  spec: RsyncDeviceSpec,
  localSource: string,
  remoteDest: string
): string[] {
  const args: string[] = ['--progress'];
  if (spec.rsh) args.push('-e', spec.rsh);
  args.push(localSource, rsyncTargetArg(spec, remoteDest));
  return args;
}
