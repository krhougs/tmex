import type { Device, TestConnectionResult } from '@tmex/shared';

import { getDeviceById } from '../db';
import { t } from '../i18n';
import { tmuxRuntimeRegistry } from '../tmux-client/registry';
import { classifySshError } from '../ws/error-classify';

interface ConnectionTestRuntime {
  connect(): Promise<void>;
  requestSnapshot(): void;
}

interface HandleDeviceTestConnectionDeps {
  getDevice: (deviceId: string) => Device | null;
  acquireRuntime: (deviceId: string) => Promise<ConnectionTestRuntime>;
  releaseRuntime: (deviceId: string, runtime: ConnectionTestRuntime) => Promise<void>;
  translate: (key: string, params?: Record<string, unknown>) => string;
}

function inferFailurePhase(errorType: string): TestConnectionResult['phase'] {
  if (errorType === 'tmux_unavailable') {
    return 'bootstrap';
  }
  return 'connect';
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

export async function handleDeviceTestConnection(
  deviceId: string,
  inputDeps: Partial<HandleDeviceTestConnectionDeps> = {}
): Promise<Response> {
  const deps: HandleDeviceTestConnectionDeps = {
    getDevice: inputDeps.getDevice ?? ((currentDeviceId) => getDeviceById(currentDeviceId)),
    acquireRuntime: inputDeps.acquireRuntime ?? ((currentDeviceId) => tmuxRuntimeRegistry.acquire(currentDeviceId)),
    releaseRuntime:
      inputDeps.releaseRuntime ??
      (async (currentDeviceId) => {
        await tmuxRuntimeRegistry.release(currentDeviceId);
      }),
    translate: inputDeps.translate ?? t,
  };

  const device = deps.getDevice(deviceId);
  if (!device) {
    return json({ error: deps.translate('apiError.deviceNotFound') }, 404);
  }

  const classifyErrorResponse = (error: unknown): Response => {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const classified = classifySshError(new Error(rawMessage));
    const payload: TestConnectionResult = {
      success: false,
      tmuxAvailable: false,
      phase: inferFailurePhase(classified.type),
      errorType: classified.type,
      message: deps.translate(classified.messageKey, classified.messageParams),
      rawMessage,
    };
    return json(payload);
  };

  let runtime: ConnectionTestRuntime | null = null;
  try {
    runtime = await deps.acquireRuntime(deviceId);
    await runtime.connect();
    runtime.requestSnapshot();

    const payload: TestConnectionResult = {
      success: true,
      tmuxAvailable: true,
      phase: 'ready',
      message: deps.translate('common.success'),
    };
    return json(payload);
  } catch (error) {
    return classifyErrorResponse(error);
  } finally {
    if (runtime) {
      await deps.releaseRuntime(deviceId, runtime);
    }
  }
}
