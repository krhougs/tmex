import { describe, expect, test } from 'bun:test';
import { enqueueDeviceJob } from './queue';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('enqueueDeviceJob', () => {
  test('serializes jobs for the same device in FIFO order', async () => {
    const events: string[] = [];
    const make = (id: string) => () =>
      (async () => {
        events.push(`start:${id}`);
        await sleep(15);
        events.push(`end:${id}`);
        return id;
      })();

    const p1 = enqueueDeviceJob('dev-a', make('1'));
    const p2 = enqueueDeviceJob('dev-a', make('2'));
    const p3 = enqueueDeviceJob('dev-a', make('3'));
    await Promise.all([p1, p2, p3]);

    // 同设备严格串行：每个 start 紧跟自己的 end，互不交错
    expect(events).toEqual(['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
  });

  test('a failing job does not block the next job on the same device', async () => {
    const p1 = enqueueDeviceJob('dev-b', () => Promise.reject(new Error('boom')));
    const p2 = enqueueDeviceJob('dev-b', () => Promise.resolve('ok'));
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
  });

  test('caps global concurrency across devices at 4', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const make = () => () =>
      (async () => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await sleep(20);
        inflight -= 1;
      })();

    // 10 个不同设备的任务（跨设备无串行约束，仅受全局并发上限）
    const jobs = Array.from({ length: 10 }, (_, i) => enqueueDeviceJob(`gdev-${i}`, make()));
    await Promise.all(jobs);
    expect(maxInflight).toBeLessThanOrEqual(4);
    expect(maxInflight).toBeGreaterThan(1);
  });
});
