import type { TmuxRuntime, TmuxRuntimeRegistryOptions } from './types';

interface RuntimeEntry<TRuntime extends TmuxRuntime> {
  refCount: number;
  promise: Promise<TRuntime>;
  runtime: TRuntime | null;
}

export class TmuxRuntimeRegistry<TRuntime extends TmuxRuntime> {
  private readonly entries = new Map<string, RuntimeEntry<TRuntime>>();
  /** runtime 已 terminated 但仍有持有者的废弃 entry：等旧持有者按实例 release 后清理 */
  private readonly orphanedEntries = new Map<string, Array<RuntimeEntry<TRuntime>>>();

  constructor(private readonly options: TmuxRuntimeRegistryOptions<TRuntime>) {}

  acquire(deviceId: string): Promise<TRuntime> {
    const existing = this.entries.get(deviceId);
    if (existing) {
      if (existing.runtime?.isTerminated) {
        // 死实例不可复用：废弃旧 entry 新建 runtime；旧持有者 release 时按实例匹配到 orphan
        this.entries.delete(deviceId);
        if (existing.refCount > 0) {
          const orphans = this.orphanedEntries.get(deviceId) ?? [];
          orphans.push(existing);
          this.orphanedEntries.set(deviceId, orphans);
        }
      } else {
        existing.refCount += 1;
        return existing.promise;
      }
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

  /**
   * 释放一次引用。runtime 传 acquire 得到的实例时按实例匹配（新旧 entry 并存场景下
   * 旧持有者只会递减自己持有的 orphan entry）；不传则按 deviceId 匹配当前 entry。
   */
  async release(deviceId: string, runtime?: object): Promise<void> {
    if (runtime) {
      const orphans = this.orphanedEntries.get(deviceId);
      if (orphans) {
        const index = orphans.findIndex((entry) => entry.runtime === runtime);
        if (index >= 0) {
          const orphan = orphans[index];
          orphan.refCount -= 1;
          if (orphan.refCount <= 0) {
            orphans.splice(index, 1);
            if (orphans.length === 0) {
              this.orphanedEntries.delete(deviceId);
            }
            await orphan.runtime?.shutdown();
          }
          return;
        }
      }
      const current = this.entries.get(deviceId);
      if (current?.runtime && current.runtime !== runtime) {
        // 持有的实例不属于当前 entry：忽略，避免误减新实例计数
        return;
      }
    }

    const entry = this.entries.get(deviceId);
    if (!entry) {
      return;
    }

    entry.refCount -= 1;
    if (entry.refCount > 0) {
      return;
    }

    this.entries.delete(deviceId);
    const resolved = await entry.promise;
    await resolved.shutdown();
  }

  async shutdownAll(): Promise<void> {
    const entries = Array.from(this.entries.values());
    this.entries.clear();
    // orphan 里的 runtime 均已 terminated，无需再 shutdown
    this.orphanedEntries.clear();

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
