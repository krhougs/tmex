import type { Device } from '@tmex/shared';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';

import { decryptWithContext } from '../crypto';
import { getDeviceById } from '../db';
import { connectionAlertNotifier } from '../push/connection-alerts';
import { buildSshBootstrapScript, parseSshBootstrapOutput } from './ssh-bootstrap';
import { resolveSshConnectConfig } from './ssh-connect-config';

export interface SshProbeResult {
  success: boolean;
  tmuxAvailable: boolean;
  phase: 'connect' | 'bootstrap' | 'ready';
  rawMessage?: string;
}

interface ProbeSshDeviceDeps {
  getDevice: (deviceId: string) => Device | null;
  decrypt: typeof decryptWithContext;
  createClient: () => Client;
}

async function connectClient(client: Client, authConfig: ConnectConfig): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const resolveOnce = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    client.on('ready', () => {
      resolveOnce();
    });
    client.on('error', (error) => {
      rejectOnce(error);
    });
    client.on('close', () => {
      rejectOnce(new Error('SSH connection closed before ready'));
    });

    client.connect(authConfig);
  });
}

async function runBootstrap(client: Client): Promise<string> {
  const stream = await new Promise<ClientChannel>((resolve, reject) => {
    client.exec('/bin/sh -s', { pty: false }, (error, channel) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(channel);
    });
  });

  return new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let closed = false;

    const finish = () => {
      if (closed) {
        return;
      }
      closed = true;
      if (stderr.trim()) {
        reject(new Error(stderr.trim()));
        return;
      }
      resolve(stdout);
    };

    stream.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    stream.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    stream.on('close', finish);
    stream.on('error', (error: Error) => {
      if (closed) {
        return;
      }
      closed = true;
      reject(error);
    });

    stream.end(`${buildSshBootstrapScript()}\n`);
  });
}

export async function probeSshDevice(
  deviceId: string,
  inputDeps: Partial<ProbeSshDeviceDeps> = {}
): Promise<SshProbeResult> {
  const deps: ProbeSshDeviceDeps = {
    getDevice: inputDeps.getDevice ?? ((currentDeviceId) => getDeviceById(currentDeviceId)),
    decrypt: inputDeps.decrypt ?? decryptWithContext,
    createClient: inputDeps.createClient ?? (() => new Client()),
  };

  const device = deps.getDevice(deviceId);
  if (!device) {
    throw new Error(`Device not found: ${deviceId}`);
  }
  if (device.type !== 'ssh') {
    throw new Error(`Ssh probe only supports ssh device: ${deviceId}`);
  }

  const client = deps.createClient();

  try {
    const authConfig = await resolveSshConnectConfig(device, deps.decrypt);
    await connectClient(client, authConfig);
    const output = await runBootstrap(client);
    const parsed = parseSshBootstrapOutput(output);
    if (!parsed.ok) {
      await connectionAlertNotifier.notify({
        device,
        error: new Error(`remote tmux unavailable: ${parsed.reason}`),
        source: 'probe',
        silentTelegram: true,
      });
      return {
        success: false,
        tmuxAvailable: false,
        phase: 'bootstrap',
        rawMessage: parsed.reason,
      };
    }

    return {
      success: true,
      tmuxAvailable: true,
      phase: 'ready',
    };
  } catch (error) {
    await connectionAlertNotifier.notify({
      device,
      error,
      source: 'probe',
      silentTelegram: true,
    });
    return {
      success: false,
      tmuxAvailable: false,
      phase: 'connect',
      rawMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    client.end();
  }
}
