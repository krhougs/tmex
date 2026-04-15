import type { TmuxRuntime, TmuxRuntimeRegistryOptions } from './types';

interface RuntimeEntry<TRuntime extends TmuxRuntime> {
  refCount: number;
  promise: Promise<TRuntime>;
  runtime: TRuntime | null;
}

export class TmuxRuntimeRegistry<TRuntime extends TmuxRuntime> {
  private readonly entries = new Map<string, RuntimeEntry<TRuntime>>();

  constructor(private readonly options: TmuxRuntimeRegistryOptions<TRuntime>) {}

  acquire(deviceId: string): Promise<TRuntime> {
    const existing = this.entries.get(deviceId);
    if (existing) {
      existing.refCount += 1;
      return existing.promise;
    }

    const entry: RuntimeEntry<TRuntime> = {
      refCount: 1,
      runtime: null,
      promise: this.options.createRuntime(deviceId).then((runtime) => {
        entry.runtime = runtime;
        return runtime;
      }),
    };

    entry.promise = entry.promise.catch((error) => {
      if (this.entries.get(deviceId) === entry) {
        this.entries.delete(deviceId);
      }
      throw error;
    });

    this.entries.set(deviceId, entry);
    return entry.promise;
  }

  async release(deviceId: string): Promise<void> {
    const entry = this.entries.get(deviceId);
    if (!entry) {
      return;
    }

    entry.refCount -= 1;
    if (entry.refCount > 0) {
      return;
    }

    this.entries.delete(deviceId);
    const runtime = await entry.promise;
    await runtime.shutdown();
  }

  async shutdownAll(): Promise<void> {
    const entries = Array.from(this.entries.values());
    this.entries.clear();

    await Promise.all(
      entries.map(async (entry) => {
        const runtime = entry.runtime ?? (await entry.promise);
        await runtime.shutdown();
      })
    );
  }
}

export function createTmuxRuntimeRegistry<TRuntime extends TmuxRuntime>(
  options: TmuxRuntimeRegistryOptions<TRuntime>
): TmuxRuntimeRegistry<TRuntime> {
  return new TmuxRuntimeRegistry(options);
}
