// 文件 IO 队列：每设备串行（同一设备同时只跑一个 rsync，避免压垮单台主机），
// 叠加全局并发上限（限制宿主机同时 spawn 的 rsync 总数，避免 IO 打爆整个程序）。

const GLOBAL_MAX_CONCURRENT = 4;

let active = 0;
const globalWaiters: Array<() => void> = [];
const deviceChains = new Map<string, Promise<unknown>>();

function acquireGlobalSlot(): Promise<void> {
  if (active < GLOBAL_MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    globalWaiters.push(() => {
      active += 1;
      resolve();
    });
  });
}

function releaseGlobalSlot(): void {
  active -= 1;
  const next = globalWaiters.shift();
  if (next) next();
}

// 投递一个设备级 IO 任务。同一 deviceId 的任务串行执行；跨设备受全局并发上限约束。
export function enqueueDeviceJob<T>(deviceId: string, job: () => Promise<T>): Promise<T> {
  const prev = deviceChains.get(deviceId) ?? Promise.resolve();
  const run = prev
    .catch(() => undefined)
    .then(async () => {
      await acquireGlobalSlot();
      try {
        return await job();
      } finally {
        releaseGlobalSlot();
      }
    });
  // 链上只保留「已结算」状态，避免单个任务失败阻断后续
  deviceChains.set(
    deviceId,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}
