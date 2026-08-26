import { wsBorsh } from '@tmex/shared';

import type {
  DeviceSessionRuntime,
  DeviceSessionRuntimeListener,
} from '../tmux-client/device-session-runtime';
import {
  type PaneHistoryCursor,
  PaneHistoryCursorError,
  type PaneHistoryPage,
} from '../tmux-client/pane-history-reader';
import {
  DEFAULT_MAX_ACTIVE_PANES,
  DEFAULT_MAX_HOT_PANES,
  type PaneDataSegment,
  type PaneIdentity,
  type PaneReplayGap,
  type PaneRetentionConsumerLease,
  type PaneScreenCheckpoint,
  type PaneSubscriptionApplyResult,
  type PaneSubscriptionRequest,
} from '../tmux-client/pane-retention';
import {
  GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS,
  GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES,
} from './terminal-output-batcher';

export const CANONICAL_MAX_SCREEN_BYTES = 6 * 1024 * 1024;
export const CANONICAL_MAX_HISTORY_PAGE_BYTES = 256 * 1024;
export const CANONICAL_MAX_PENDING_PANE_GAPS = 256;
export const CANONICAL_MAX_INPUT_DEDUP_IDS = 1_024;
const ENVELOPE_BYTES = 16;

type CanonicalEvent = wsBorsh.CanonicalEvent;
type CanonicalCommand = wsBorsh.CanonicalCommand;
type CanonicalPaneTarget = wsBorsh.CanonicalPaneTarget;
type CanonicalPaneSubscription = wsBorsh.CanonicalPaneSubscription;

export interface CanonicalFeedRuntime
  extends Pick<
    DeviceSessionRuntime,
    | 'getServerEpoch'
    | 'getMetadataSnapshot'
    | 'getPaneIdentity'
    | 'attachPaneConsumer'
    | 'subscribe'
    | 'readPaneHistory'
    | 'captureCanonicalScreen'
    | 'sendInputBytes'
    | 'resizePane'
  > {}

export interface CanonicalFeedSessionOptions {
  maxFrameBytes: number;
  sendEvents: (events: CanonicalEvent[]) => boolean;
  resolveRuntime: (deviceId: string) => Promise<CanonicalFeedRuntime | null>;
  initialDeviceIds?: () => Iterable<string>;
  onDeviceAttached?: (deviceId: string, runtime: CanonicalFeedRuntime) => void;
  onDeviceDetached?: (deviceId: string, runtime: CanonicalFeedRuntime) => void;
  createEpoch?: () => Uint8Array;
  maxPendingPaneGaps?: number;
}

export interface CanonicalFeedSessionStats {
  attachedRuntimes: number;
  screenJobs: number;
  gatedPanes: number;
  pendingPaneGaps: number;
  pendingPaneGapLimit: number;
  streamGapPending: boolean;
  inputDedupIds: number;
  inputDedupLimit: number;
  paneDataDeliveries: number;
  paneDataBytes: number;
  paneDataDrops: number;
  paneDataDropBytes: number;
  pendingPaneGapOverflows: number;
  paneGapsSent: number;
  paneGapsByReason: Record<PaneReplayGap['reason'], number>;
  streamGapsSent: number;
  screenTransactionsStarted: number;
  screenTransactionsCompleted: number;
  screenTransactionsFailed: number;
  screenTransactionsCancelled: number;
}

interface AttachedDevice {
  deviceId: string;
  runtime: CanonicalFeedRuntime;
  lease: PaneRetentionConsumerLease;
  detachListener: () => void;
  metadataNeedsRebase: boolean;
}

interface ScreenJob {
  key: string;
  requestId: Uint8Array;
  cancelled: boolean;
}

interface ResolvedTarget {
  device: AttachedDevice;
  pane: PaneIdentity;
  target: CanonicalPaneTarget;
}

function defaultCreateEpoch(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

function copyBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function bytesHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const CANONICAL_PENDING_SWEEP_MS = 250;

interface PendingPaneDataBatch {
  deviceId: string;
  paneId: string;
  paneEpoch: Uint8Array;
  seqStart: bigint;
  seqEnd: bigint;
  chunks: Uint8Array[];
  length: number;
  timer: ReturnType<typeof setTimeout>;
}

function paneKey(deviceId: string, paneId: string): string {
  return `${deviceId}\0${paneId}`;
}

function sourceGapReason(reason: PaneReplayGap['reason']): number {
  if (reason === 'epoch_changed') return wsBorsh.SOURCE_GAP_REASON_EPOCH_CHANGED;
  if (reason === 'cache_evicted') return wsBorsh.SOURCE_GAP_REASON_CACHE_EVICTED;
  return wsBorsh.SOURCE_GAP_REASON_PANE_GAP;
}

function rejectionReason(reason: string): number {
  if (reason === 'resource_exhausted') return wsBorsh.SUBSCRIPTION_REJECTED_RESOURCE_EXHAUSTED;
  if (reason === 'epoch_changed') return wsBorsh.SUBSCRIPTION_REJECTED_EPOCH_CHANGED;
  return wsBorsh.SUBSCRIPTION_REJECTED_NOT_FOUND;
}

export class CanonicalFeedSession {
  private readonly devices = new Map<string, AttachedDevice>();
  private readonly screenJobs = new Map<string, ScreenJob>();
  private readonly paneSendGaps = new Map<string, PaneReplayGap>();
  private readonly paneDataBatches = new Map<string, PendingPaneDataBatch>();
  private readonly inputIds = new Set<string>();
  private readonly inputIdOrder: string[] = [];
  private readonly gatewayEpoch: Uint8Array;
  private readonly maxFrameBytes: number;
  private readonly maxPendingPaneGaps: number;
  private readySent = false;
  private bootstrapped = false;
  private closed = false;
  private streamGapPendingReason: number | null = null;
  private paneDataDeliveries = 0;
  private paneDataBytes = 0;
  private paneDataDrops = 0;
  private paneDataDropBytes = 0;
  private pendingPaneGapOverflows = 0;
  private paneGapsSent = 0;
  private readonly paneGapsByReason: Record<PaneReplayGap['reason'], number> = {
    pane_gap: 0,
    epoch_changed: 0,
    cache_evicted: 0,
  };
  private streamGapsSent = 0;
  private screenTransactionsStarted = 0;
  private screenTransactionsCompleted = 0;
  private screenTransactionsFailed = 0;
  private screenTransactionsCancelled = 0;
  private pendingSweepTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: CanonicalFeedSessionOptions) {
    this.maxFrameBytes = Math.min(
      Math.max(ENVELOPE_BYTES + 64, options.maxFrameBytes),
      wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES
    );
    this.maxPendingPaneGaps = options.maxPendingPaneGaps ?? CANONICAL_MAX_PENDING_PANE_GAPS;
    if (!Number.isSafeInteger(this.maxPendingPaneGaps) || this.maxPendingPaneGaps <= 0) {
      throw new Error('pending pane gap limit must be a positive safe integer');
    }
    this.gatewayEpoch = copyBytes((options.createEpoch ?? defaultCreateEpoch)());
    if (this.gatewayEpoch.byteLength !== 16) throw new Error('gateway epoch must be 16 bytes');
  }

  snapshotStats(): CanonicalFeedSessionStats {
    return {
      attachedRuntimes: this.devices.size,
      screenJobs: this.screenJobs.size,
      gatedPanes: 0,
      pendingPaneGaps: this.paneSendGaps.size,
      pendingPaneGapLimit: this.maxPendingPaneGaps,
      streamGapPending: this.streamGapPendingReason !== null,
      inputDedupIds: this.inputIds.size,
      inputDedupLimit: CANONICAL_MAX_INPUT_DEDUP_IDS,
      paneDataDeliveries: this.paneDataDeliveries,
      paneDataBytes: this.paneDataBytes,
      paneDataDrops: this.paneDataDrops,
      paneDataDropBytes: this.paneDataDropBytes,
      pendingPaneGapOverflows: this.pendingPaneGapOverflows,
      paneGapsSent: this.paneGapsSent,
      paneGapsByReason: { ...this.paneGapsByReason },
      streamGapsSent: this.streamGapsSent,
      screenTransactionsStarted: this.screenTransactionsStarted,
      screenTransactionsCompleted: this.screenTransactionsCompleted,
      screenTransactionsFailed: this.screenTransactionsFailed,
      screenTransactionsCancelled: this.screenTransactionsCancelled,
    };
  }

  async handleCommand(command: CanonicalCommand): Promise<void> {
    if (this.closed) return;
    this.ensureReady();
    await this.bootstrapInitialDevices();
    try {
      if ('SetPaneSubscriptions' in command) {
        await this.handleSetPaneSubscriptions(command.SetPaneSubscriptions);
      } else if ('TerminalInput' in command) {
        await this.handleTerminalInput(command.TerminalInput);
      } else if ('ResizePane' in command) {
        await this.handleResizePane(command.ResizePane);
      } else if ('RequestScreen' in command) {
        await this.handleRequestScreen(command.RequestScreen);
      } else if ('RequestHistory' in command) {
        await this.handleRequestHistory(command.RequestHistory);
      }
    } catch (error) {
      this.sendError(
        null,
        error instanceof wsBorsh.WsBorshError ? error.code : wsBorsh.ERROR_INTERNAL_ERROR,
        error instanceof Error ? error.message : 'canonical command failed',
        false
      );
    }
  }

  async attachDevice(deviceId: string, runtime?: CanonicalFeedRuntime): Promise<boolean> {
    if (this.closed) return false;
    this.ensureReady();
    const existing = this.devices.get(deviceId);
    if (existing && (!runtime || existing.runtime === runtime)) return true;
    if (existing) this.detachDevice(deviceId);
    const resolved = runtime ?? (await this.options.resolveRuntime(deviceId));
    if (!resolved) return false;

    let attached: AttachedDevice | null = null;
    const lease = resolved.attachPaneConsumer({
      onData: (segment) => this.handlePaneData(deviceId, segment),
      onGap: (gap) => this.handlePaneGap(deviceId, gap),
    });
    const listener: DeviceSessionRuntimeListener = {
      onMetadataPatch: (patch) => {
        if (!attached) return;
        if (!this.eventFits({ SourceMetadataPatch: patch })) {
          attached.metadataNeedsRebase = true;
          this.sendMetadataSnapshot(attached);
          return;
        }
        if (!this.send({ SourceMetadataPatch: patch })) attached.metadataNeedsRebase = true;
      },
      onMetadataRebaseRequired: () => {
        if (!attached) return;
        attached.metadataNeedsRebase = true;
        this.sendMetadataSnapshot(attached);
      },
      onClose: () => {
        if (!attached) return;
        attached.metadataNeedsRebase = true;
        this.sendOrQueueStreamGap(wsBorsh.SOURCE_GAP_REASON_EPOCH_CHANGED);
      },
    };
    attached = {
      deviceId,
      runtime: resolved,
      lease,
      detachListener: resolved.subscribe(listener),
      metadataNeedsRebase: true,
    };
    this.devices.set(deviceId, attached);
    this.options.onDeviceAttached?.(deviceId, resolved);
    this.sendMetadataSnapshot(attached);
    return true;
  }

  detachDevice(deviceId: string): void {
    const attached = this.devices.get(deviceId);
    if (!attached) return;
    this.flushPaneDataBatchesForDevice(deviceId);
    this.devices.delete(deviceId);
    attached.lease.close();
    attached.detachListener();
    for (const [key, job] of this.screenJobs) {
      if (key.startsWith(`${deviceId}\0`)) {
        this.cancelScreenJob(job);
        this.screenJobs.delete(key);
      }
    }
    this.options.onDeviceDetached?.(deviceId, attached.runtime);
  }

  // pending 项原本只由 Bun 的 drain 回调推进，而 drain 仅在 socket 曾经背压后排空时派发。
  // 当发送因非背压原因失败（例如 socket 暂时不可发）时，drain 永远不会到来，
  // 这些 pending 项会无限期挂起：metadata 不再刷新、pane gap 不再补、首屏也不再重启。
  // 因此在存在 pending 时挂一个低频兜底 tick，让推进不依赖 drain 事件。
  private schedulePendingSweep(): void {
    if (this.closed || this.pendingSweepTimer !== null) return;
    if (
      this.streamGapPendingReason === null &&
      this.paneSendGaps.size === 0 &&
      !Array.from(this.devices.values()).some((device) => device.metadataNeedsRebase)
    ) {
      return;
    }
    this.pendingSweepTimer = setTimeout(() => {
      this.pendingSweepTimer = null;
      if (this.closed) return;
      this.onDrain();
    }, CANONICAL_PENDING_SWEEP_MS);
    this.pendingSweepTimer.unref?.();
  }

  onDrain(): void {
    if (this.closed) return;
    if (this.streamGapPendingReason !== null) {
      if (!this.sendStreamGap(this.streamGapPendingReason)) return;
      this.streamGapPendingReason = null;
      this.paneSendGaps.clear();
    }
    for (const device of this.devices.values()) {
      if (device.metadataNeedsRebase) this.sendMetadataSnapshot(device);
    }
    // gap 发出即止：首屏一律由客户端 RequestScreenSnapshot 驱动。
    // 在此自动重拍会把快照压回同一条仍拥塞的 socket，失败后再 gap，形成正反馈。
    for (const [key, gap] of Array.from(this.paneSendGaps)) {
      if (!this.sendPaneGap(key.split('\0')[0] ?? '', gap)) continue;
      this.paneSendGaps.delete(key);
    }
    this.schedulePendingSweep();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.discardPaneDataBatches();
    for (const job of this.screenJobs.values()) this.cancelScreenJob(job);
    this.screenJobs.clear();
    this.paneSendGaps.clear();
    this.streamGapPendingReason = null;
    if (this.pendingSweepTimer !== null) {
      clearTimeout(this.pendingSweepTimer);
      this.pendingSweepTimer = null;
    }
    for (const deviceId of Array.from(this.devices.keys())) this.detachDevice(deviceId);
  }

  private ensureReady(): void {
    if (this.readySent) return;
    this.readySent = true;
    this.send({
      FeedReady: {
        gatewayEpoch: copyBytes(this.gatewayEpoch),
        maxFrameBytes: this.maxFrameBytes,
        maxActivePanes: DEFAULT_MAX_ACTIVE_PANES,
        maxHotPanes: DEFAULT_MAX_HOT_PANES,
        maxScreenBytes: CANONICAL_MAX_SCREEN_BYTES,
        maxHistoryPageBytes: CANONICAL_MAX_HISTORY_PAGE_BYTES,
      },
    });
  }

  private async bootstrapInitialDevices(): Promise<void> {
    if (this.bootstrapped) return;
    this.bootstrapped = true;
    await Promise.all(
      Array.from(this.options.initialDeviceIds?.() ?? [], (deviceId) => this.attachDevice(deviceId))
    );
  }

  private async ensureDevice(deviceId: string): Promise<AttachedDevice | null> {
    const existing = this.devices.get(deviceId);
    if (existing) return existing;
    return (await this.attachDevice(deviceId)) ? (this.devices.get(deviceId) ?? null) : null;
  }

  private async handleSetPaneSubscriptions(command: {
    generation: bigint;
    activePanes: CanonicalPaneSubscription[];
    hotPanes: CanonicalPaneSubscription[];
  }): Promise<void> {
    const requestedDeviceIds = new Set(
      [...command.activePanes, ...command.hotPanes].map(
        (subscription) => subscription.pane.deviceId
      )
    );
    await Promise.all(Array.from(requestedDeviceIds, (deviceId) => this.ensureDevice(deviceId)));

    const activeByDevice = new Map<string, PaneSubscriptionRequest[]>();
    const hotByDevice = new Map<string, PaneSubscriptionRequest[]>();
    const rejected: Array<{
      pane: CanonicalPaneTarget;
      reason: number;
    }> = [];

    const collect = (
      subscriptions: CanonicalPaneSubscription[],
      destination: Map<string, PaneSubscriptionRequest[]>
    ) => {
      for (const subscription of subscriptions) {
        const target = subscription.pane;
        const device = this.devices.get(target.deviceId);
        const serverEpoch = device?.runtime.getServerEpoch();
        const pane = device?.runtime.getPaneIdentity(target.paneId);
        if (!device || !serverEpoch || !pane) {
          rejected.push({ pane: target, reason: wsBorsh.SUBSCRIPTION_REJECTED_NOT_FOUND });
          continue;
        }
        if (
          !bytesEqual(serverEpoch, target.serverEpoch) ||
          !bytesEqual(pane.paneEpoch, subscription.cursor?.paneEpoch ?? pane.paneEpoch)
        ) {
          rejected.push({ pane: target, reason: wsBorsh.SUBSCRIPTION_REJECTED_EPOCH_CHANGED });
          continue;
        }
        const requests = destination.get(target.deviceId) ?? [];
        requests.push({
          paneId: target.paneId,
          paneEpoch: pane.paneEpoch,
          cursor: subscription.cursor
            ? {
                paneEpoch: copyBytes(subscription.cursor.paneEpoch),
                terminalSeq: subscription.cursor.terminalSeq,
              }
            : null,
        });
        destination.set(target.deviceId, requests);
      }
    };
    collect(command.activePanes, activeByDevice);
    collect(command.hotPanes, hotByDevice);

    const applyResults: Array<{ device: AttachedDevice; result: PaneSubscriptionApplyResult }> = [];
    for (const device of this.devices.values()) {
      const result = device.lease.applySubscriptions(
        command.generation,
        activeByDevice.get(device.deviceId) ?? [],
        hotByDevice.get(device.deviceId) ?? []
      );
      applyResults.push({ device, result });
      const serverEpoch = device.runtime.getServerEpoch();
      if (!serverEpoch) continue;
      for (const item of result.rejected) {
        rejected.push({
          pane: { deviceId: device.deviceId, serverEpoch, paneId: item.paneId },
          reason: rejectionReason(item.reason),
        });
      }
    }

    const appliedGeneration = applyResults.reduce(
      (latest, item) => (item.result.generation > latest ? item.result.generation : latest),
      command.generation
    );
    const activePanes: CanonicalPaneTarget[] = [];
    const hotPanes: CanonicalPaneTarget[] = [];
    const retainedKeys = new Set<string>();
    for (const { device, result } of applyResults) {
      for (const pane of result.activePanes) {
        retainedKeys.add(paneKey(device.deviceId, pane.paneId));
      }
      for (const pane of result.hotPanes) {
        retainedKeys.add(paneKey(device.deviceId, pane.paneId));
      }
      const serverEpoch = device.runtime.getServerEpoch();
      if (!serverEpoch) continue;
      activePanes.push(
        ...result.activePanes.map((pane) => ({
          deviceId: device.deviceId,
          serverEpoch,
          paneId: pane.paneId,
        }))
      );
      hotPanes.push(
        ...result.hotPanes.map((pane) => ({
          deviceId: device.deviceId,
          serverEpoch,
          paneId: pane.paneId,
        }))
      );
    }

    // raw 直通语义：订阅集合变化只取消「不再被订阅」pane 的首屏任务；
    // 仍在集合内的任务不受后续 pane 挂载影响。
    for (const [key, job] of Array.from(this.screenJobs)) {
      if (!retainedKeys.has(key)) this.cancelScreenJob(job);
    }
    this.send({
      SubscriptionApplied: {
        generation: appliedGeneration,
        activePanes,
        hotPanes,
        rejected,
      },
    });
  }

  private async handleTerminalInput(command: {
    requestId: Uint8Array;
    pane: CanonicalPaneTarget;
    paneEpoch: Uint8Array;
    inputId: Uint8Array;
    data: Uint8Array;
  }): Promise<void> {
    const target = await this.resolveTarget(command.pane, command.requestId);
    if (!target) return;
    if (!bytesEqual(command.paneEpoch, target.pane.paneEpoch)) {
      this.sendTargetGap(command.pane, command.paneEpoch, 0n, target.pane.paneEpoch, 0n);
      return;
    }
    const inputId = bytesHex(command.inputId);
    if (this.inputIds.has(inputId)) return;
    this.inputIds.add(inputId);
    this.inputIdOrder.push(inputId);
    while (this.inputIdOrder.length > CANONICAL_MAX_INPUT_DEDUP_IDS) {
      const removed = this.inputIdOrder.shift();
      if (removed) this.inputIds.delete(removed);
    }
    target.device.runtime.sendInputBytes(target.pane.paneId, command.data);
  }

  private async handleResizePane(command: {
    requestId: Uint8Array;
    pane: CanonicalPaneTarget;
    rows: number;
    cols: number;
  }): Promise<void> {
    const target = await this.resolveTarget(command.pane, command.requestId);
    if (!target) return;
    if (command.rows < 2 || command.cols < 2) {
      this.sendError(command.requestId, wsBorsh.ERROR_INVALID_FRAME, 'invalid pane size', false);
      return;
    }
    target.device.runtime.resizePane(target.pane.paneId, command.cols, command.rows);
  }

  private async handleRequestScreen(command: {
    requestId: Uint8Array;
    pane: CanonicalPaneTarget;
    byteLimit: number;
  }): Promise<void> {
    const target = await this.resolveTarget(command.pane, command.requestId);
    if (!target) return;
    if (command.byteLimit < 64) {
      this.sendError(
        command.requestId,
        wsBorsh.ERROR_INVALID_FRAME,
        'screen byte limit too small',
        false
      );
      return;
    }
    this.startScreenJob(
      target.device,
      target.pane,
      command.requestId,
      Math.min(command.byteLimit, CANONICAL_MAX_SCREEN_BYTES)
    );
  }

  private async handleRequestHistory(command: {
    requestId: Uint8Array;
    pane: CanonicalPaneTarget;
    beforeCursor: PaneHistoryCursor | null;
    byteLimit: number;
  }): Promise<void> {
    const target = await this.resolveTarget(command.pane, command.requestId);
    if (!target) return;
    const byteLimit = Math.min(command.byteLimit, CANONICAL_MAX_HISTORY_PAGE_BYTES);
    if (byteLimit === 0) {
      this.sendError(
        command.requestId,
        wsBorsh.ERROR_INVALID_FRAME,
        'history byte limit is zero',
        false
      );
      return;
    }
    let page: PaneHistoryPage | null;
    try {
      page = await target.device.runtime.readPaneHistory(
        target.pane.paneId,
        command.beforeCursor,
        byteLimit
      );
    } catch (error) {
      if (error instanceof PaneHistoryCursorError) {
        this.sendError(command.requestId, wsBorsh.ERROR_TMUX_NOT_READY, error.message, true);
        return;
      }
      throw error;
    }
    if (!page) {
      this.sendError(
        command.requestId,
        wsBorsh.ERROR_TMUX_TARGET_NOT_FOUND,
        'pane not found',
        false
      );
      return;
    }
    this.sendHistoryTransaction(target.target, command.requestId, page);
  }

  private async resolveTarget(
    target: CanonicalPaneTarget,
    requestId: Uint8Array | null
  ): Promise<ResolvedTarget | null> {
    const device = await this.ensureDevice(target.deviceId);
    const serverEpoch = device?.runtime.getServerEpoch();
    const pane = device?.runtime.getPaneIdentity(target.paneId);
    if (!device || !serverEpoch || !pane) {
      this.sendError(requestId, wsBorsh.ERROR_TMUX_TARGET_NOT_FOUND, 'pane not found', false);
      return null;
    }
    if (!bytesEqual(target.serverEpoch, serverEpoch)) {
      this.sendOrQueueStreamGap(wsBorsh.SOURCE_GAP_REASON_EPOCH_CHANGED);
      return null;
    }
    return {
      device,
      pane,
      target: { deviceId: target.deviceId, serverEpoch, paneId: target.paneId },
    };
  }

  private startScreenJob(
    device: AttachedDevice,
    pane: PaneIdentity,
    requestId: Uint8Array,
    byteLimit: number
  ): void {
    const key = paneKey(device.deviceId, pane.paneId);
    const existing = this.screenJobs.get(key);
    if (existing) this.cancelScreenJob(existing);
    const job: ScreenJob = {
      key,
      requestId: copyBytes(requestId),
      cancelled: false,
    };
    this.screenJobs.set(key, job);
    this.screenTransactionsStarted += 1;
    void this.runScreenJob(job, device, pane, byteLimit);
  }

  // raw 直通语义：快照只是画面基线（capture-pane 当刻状态），不 gate live 流、
  // 不从 replay 缓存拼接续传。live 帧与快照的先后顺序由客户端处理：
  // 收到快照即 reset+write，其后 live 直写。
  private async runScreenJob(
    job: ScreenJob,
    device: AttachedDevice,
    pane: PaneIdentity,
    byteLimit: number
  ): Promise<void> {
    let completed = false;
    try {
      const checkpoint = await device.runtime.captureCanonicalScreen(pane.paneId, byteLimit);
      if (!this.isCurrentScreenJob(job)) return;
      if (!checkpoint) {
        this.sendError(job.requestId, wsBorsh.ERROR_TMUX_NOT_READY, 'screen unavailable', true);
        return;
      }
      if (!this.sendScreenTransaction(device.deviceId, job.requestId, checkpoint)) return;
      completed = true;
    } catch (error) {
      if (this.isCurrentScreenJob(job)) {
        this.sendError(
          job.requestId,
          wsBorsh.ERROR_INTERNAL_ERROR,
          error instanceof Error ? error.message : 'screen capture failed',
          true
        );
      }
    } finally {
      if (this.screenJobs.get(job.key) === job) {
        this.screenJobs.delete(job.key);
      }
      if (completed) this.screenTransactionsCompleted += 1;
      else if (!job.cancelled) this.screenTransactionsFailed += 1;
    }
  }

  private isCurrentScreenJob(job: ScreenJob): boolean {
    return !this.closed && !job.cancelled && this.screenJobs.get(job.key) === job;
  }

  // tmux 一次整屏重绘会以几十个独立 %output 到达；legacy 广播路径经 TerminalOutputBatcher
  // 合帧，canonical 路径若逐段直发，同样的重绘就变成几十个独立帧一路放大到客户端
  // （每帧独立编码/加密/系统调用，公网上被 RTT 摊开跨渲染帧到达，表现为逐行扫描式重绘，
  // 客户端主线程也被 message 洪水填满拖慢输入）。此处按 legacy 相同参数（16ms/64KiB）
  // 对 seq 连续的同 pane 段合帧；发出任何同 pane 的 gap/快照/目标 gap 前必须先 flush，
  // 保持 pane 内事件全序。
  private handlePaneData(deviceId: string, segment: PaneDataSegment): void {
    const key = paneKey(deviceId, segment.paneId);
    const pending = this.paneDataBatches.get(key);
    if (pending) {
      if (
        bytesEqual(pending.paneEpoch, segment.paneEpoch) &&
        pending.seqEnd === segment.seqStart
      ) {
        pending.chunks.push(segment.data);
        pending.length += segment.data.byteLength;
        pending.seqEnd = segment.seqEnd;
        if (pending.length >= GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES) this.flushPaneDataBatch(key);
        return;
      }
      this.flushPaneDataBatch(key);
    }
    if (segment.data.byteLength >= GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES) {
      this.sendPaneData(deviceId, segment);
      return;
    }
    this.paneDataBatches.set(key, {
      deviceId,
      paneId: segment.paneId,
      paneEpoch: segment.paneEpoch,
      seqStart: segment.seqStart,
      seqEnd: segment.seqEnd,
      chunks: [segment.data],
      length: segment.data.byteLength,
      timer: setTimeout(() => this.flushPaneDataBatch(key), GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS),
    });
  }

  private flushPaneDataBatch(key: string): void {
    const pending = this.paneDataBatches.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.paneDataBatches.delete(key);
    let data: Uint8Array;
    if (pending.chunks.length === 1) {
      data = pending.chunks[0]!;
    } else {
      data = new Uint8Array(pending.length);
      let offset = 0;
      for (const chunk of pending.chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    this.sendPaneData(pending.deviceId, {
      paneId: pending.paneId,
      paneEpoch: pending.paneEpoch,
      seqStart: pending.seqStart,
      seqEnd: pending.seqEnd,
      data,
    });
  }

  private flushPaneDataBatchesForDevice(deviceId: string): void {
    for (const key of Array.from(this.paneDataBatches.keys())) {
      if (key.startsWith(`${deviceId}\0`)) this.flushPaneDataBatch(key);
    }
  }

  private discardPaneDataBatches(): void {
    for (const pending of this.paneDataBatches.values()) clearTimeout(pending.timer);
    this.paneDataBatches.clear();
  }

  private handlePaneGap(deviceId: string, gap: PaneReplayGap): void {
    this.flushPaneDataBatch(paneKey(deviceId, gap.paneId));
    this.sendPaneGap(deviceId, gap);
  }

  private sendPaneData(deviceId: string, segment: PaneDataSegment): boolean {
    const device = this.devices.get(deviceId);
    const serverEpoch = device?.runtime.getServerEpoch();
    if (!device || !serverEpoch) {
      this.recordPaneDataDrop(segment.data.byteLength);
      return false;
    }
    const key = paneKey(deviceId, segment.paneId);
    const target = { deviceId, serverEpoch, paneId: segment.paneId };
    const maxDataBytes = this.maxPaneDataBytes(target, segment.paneEpoch);
    if (maxDataBytes <= 0) {
      this.recordPaneDataDrop(segment.data.byteLength);
      return false;
    }
    let offset = 0;
    while (offset < segment.data.byteLength) {
      const data = segment.data.slice(offset, offset + maxDataBytes);
      const seqStart = segment.seqStart + BigInt(offset);
      const event: CanonicalEvent = {
        PaneData: {
          pane: target,
          paneEpoch: copyBytes(segment.paneEpoch),
          seqStart,
          seqEnd: seqStart + BigInt(data.byteLength),
          data,
        },
      };
      if (!this.send(event)) {
        const gap: PaneReplayGap = {
          paneId: segment.paneId,
          paneEpoch: copyBytes(segment.paneEpoch),
          reason: 'pane_gap',
          expectedPaneEpoch: copyBytes(segment.paneEpoch),
          expectedSeq: seqStart,
          availableSeq: segment.seqEnd,
        };
        this.recordPaneDataDrop(segment.data.byteLength - offset);
        this.queuePaneGap(key, gap);
        return false;
      }
      this.paneDataDeliveries += 1;
      this.paneDataBytes += data.byteLength;
      offset += data.byteLength;
    }
    return true;
  }

  private sendPaneGap(deviceId: string, gap: PaneReplayGap): boolean {
    const device = this.devices.get(deviceId);
    const serverEpoch = device?.runtime.getServerEpoch();
    if (!serverEpoch) return false;
    const sent = this.send({
      SourceGap: {
        reason: sourceGapReason(gap.reason),
        scope: {
          Pane: {
            pane: { deviceId, serverEpoch, paneId: gap.paneId },
            expectedPaneEpoch: copyBytes(gap.expectedPaneEpoch),
            availablePaneEpoch: copyBytes(gap.paneEpoch),
            expectedSeq: gap.expectedSeq,
            availableSeq: gap.availableSeq,
          },
        },
      },
    });
    if (sent) {
      this.paneGapsSent += 1;
      this.paneGapsByReason[gap.reason] += 1;
    }
    return sent;
  }

  private sendTargetGap(
    target: CanonicalPaneTarget,
    expectedPaneEpoch: Uint8Array,
    expectedSeq: bigint,
    availablePaneEpoch: Uint8Array,
    availableSeq: bigint
  ): void {
    this.flushPaneDataBatch(paneKey(target.deviceId, target.paneId));
    const sent = this.send({
      SourceGap: {
        reason: wsBorsh.SOURCE_GAP_REASON_EPOCH_CHANGED,
        scope: {
          Pane: {
            pane: target,
            expectedPaneEpoch,
            availablePaneEpoch,
            expectedSeq,
            availableSeq,
          },
        },
      },
    });
    if (sent) {
      this.paneGapsSent += 1;
      this.paneGapsByReason.epoch_changed += 1;
    }
  }

  private sendStreamGap(reason: number): boolean {
    const sent = this.send({
      SourceGap: {
        reason,
        scope: { Stream: {} },
      },
    });
    if (sent) this.streamGapsSent += 1;
    return sent;
  }

  private sendOrQueueStreamGap(reason: number): void {
    if (!this.sendStreamGap(reason)) this.streamGapPendingReason = reason;
  }

  private queuePaneGap(key: string, gap: PaneReplayGap): void {
    if (this.streamGapPendingReason !== null || this.paneSendGaps.has(key)) {
      if (this.streamGapPendingReason === null) this.paneSendGaps.set(key, gap);
      return;
    }
    if (this.paneSendGaps.size < this.maxPendingPaneGaps) {
      this.paneSendGaps.set(key, gap);
      return;
    }
    this.pendingPaneGapOverflows += 1;
    this.paneSendGaps.clear();
    this.streamGapPendingReason = wsBorsh.SOURCE_GAP_REASON_PANE_GAP;
  }

  private recordPaneDataDrop(bytes: number): void {
    this.paneDataDrops += 1;
    this.paneDataDropBytes += Math.max(0, bytes);
  }

  private cancelScreenJob(job: ScreenJob): void {
    if (job.cancelled) return;
    job.cancelled = true;
    this.screenTransactionsCancelled += 1;
  }

  // 快照屏障（baseSeq）前的待发数据已包含在快照正文里，直接发出会紧贴在 ScreenBegin
  // 之前到达、被客户端 reset 抹掉的是屏障之后的部分——因此按 baseSeq 切分：
  // ≤baseSeq 丢弃（快照取代之），>baseSeq 扣到 ScreenCommit 之后补发。
  private splitPaneDataBatchAtBase(
    key: string,
    paneEpoch: Uint8Array,
    baseSeq: bigint
  ): PaneDataSegment | null {
    const pending = this.paneDataBatches.get(key);
    if (!pending) return null;
    if (!bytesEqual(pending.paneEpoch, paneEpoch)) {
      this.flushPaneDataBatch(key);
      return null;
    }
    clearTimeout(pending.timer);
    this.paneDataBatches.delete(key);
    if (pending.seqEnd <= baseSeq) return null;
    let data: Uint8Array;
    if (pending.chunks.length === 1) {
      data = pending.chunks[0]!;
    } else {
      data = new Uint8Array(pending.length);
      let offset = 0;
      for (const chunk of pending.chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    let seqStart = pending.seqStart;
    if (seqStart < baseSeq) {
      data = data.subarray(Number(baseSeq - seqStart));
      seqStart = baseSeq;
    }
    if (data.byteLength === 0) return null;
    return {
      paneId: pending.paneId,
      paneEpoch: pending.paneEpoch,
      seqStart,
      seqEnd: pending.seqEnd,
      data,
    };
  }

  private sendScreenTransaction(
    deviceId: string,
    requestId: Uint8Array,
    checkpoint: PaneScreenCheckpoint
  ): boolean {
    const serverEpoch = this.devices.get(deviceId)?.runtime.getServerEpoch();
    if (!serverEpoch) return false;
    const heldLive = this.splitPaneDataBatchAtBase(
      paneKey(deviceId, checkpoint.paneId),
      checkpoint.paneEpoch,
      checkpoint.baseSeq
    );
    const begin: CanonicalEvent = {
      ScreenBegin: {
        requestId,
        pane: { deviceId, serverEpoch, paneId: checkpoint.paneId },
        paneEpoch: copyBytes(checkpoint.paneEpoch),
        baseSeq: checkpoint.baseSeq,
        rows: checkpoint.rows,
        cols: checkpoint.cols,
        modes: checkpoint.modes,
        totalBytes: checkpoint.data.byteLength,
      },
    };
    const chunks = this.contentChunkEvents('screen', requestId, checkpoint.data);
    if (!chunks) return false;
    const committed = this.sendBatch([
      begin,
      ...chunks,
      {
        ScreenCommit: {
          requestId,
          totalBytes: checkpoint.data.byteLength,
          historyCursor: checkpoint.historyCursor,
        },
      },
    ]);
    if (committed && heldLive) this.sendPaneData(deviceId, heldLive);
    return committed;
  }

  private sendHistoryTransaction(
    target: CanonicalPaneTarget,
    requestId: Uint8Array,
    page: PaneHistoryPage
  ): boolean {
    this.flushPaneDataBatch(paneKey(target.deviceId, target.paneId));
    if (
      !this.send({
        HistoryBegin: {
          requestId,
          pane: target,
          paneEpoch: page.paneEpoch,
          historyEpoch: page.historyEpoch,
          lineStart: page.lineStart,
          lineEnd: page.lineEnd,
          truncated: page.truncated,
          totalBytes: page.data.byteLength,
        },
      })
    ) {
      return false;
    }
    if (!this.sendContentChunks('history', requestId, page.data)) return false;
    return this.send({
      HistoryCommit: {
        requestId,
        totalBytes: page.data.byteLength,
        nextCursor: page.nextCursor,
      },
    });
  }

  private contentChunkEvents(
    kind: 'screen' | 'history',
    requestId: Uint8Array,
    data: Uint8Array
  ): CanonicalEvent[] | null {
    const maxDataBytes = this.maxContentChunkBytes(kind, requestId);
    if (maxDataBytes <= 0) return null;
    const events: CanonicalEvent[] = [];
    for (let offset = 0; offset < data.byteLength; offset += maxDataBytes) {
      events.push(
        kind === 'screen'
          ? {
              ScreenChunk: { requestId, offset, data: data.slice(offset, offset + maxDataBytes) },
            }
          : {
              HistoryChunk: { requestId, offset, data: data.slice(offset, offset + maxDataBytes) },
            }
      );
    }
    return events;
  }

  private sendContentChunks(
    kind: 'screen' | 'history',
    requestId: Uint8Array,
    data: Uint8Array
  ): boolean {
    const events = this.contentChunkEvents(kind, requestId, data);
    return events !== null && events.every((event) => this.send(event));
  }

  private sendMetadataSnapshot(device: AttachedDevice): boolean {
    const snapshot = device.runtime.getMetadataSnapshot();
    const snapshotId = defaultCreateEpoch();
    const chunks = this.partitionMetadataRecords(snapshot, snapshotId);
    if (!chunks) return false;
    let sent = true;
    for (let index = 0; index < chunks.length; index += 1) {
      sent =
        this.send({
          SourceMetadataSnapshot: {
            metadataEpoch: snapshot.metadataEpoch,
            revision: snapshot.revision,
            snapshotId,
            chunkIndex: index,
            totalChunks: chunks.length,
            records: chunks[index] ?? [],
          },
        }) && sent;
      if (!sent) break;
    }
    device.metadataNeedsRebase = !sent;
    return sent;
  }

  private partitionMetadataRecords(
    snapshot: ReturnType<CanonicalFeedRuntime['getMetadataSnapshot']>,
    snapshotId: Uint8Array
  ): wsBorsh.SourceMetadataRecord[][] | null {
    if (snapshot.records.length === 0) return [[]];
    const chunks: wsBorsh.SourceMetadataRecord[][] = [];
    let current: wsBorsh.SourceMetadataRecord[] = [];
    for (const record of snapshot.records) {
      const candidate = [...current, record];
      const event: CanonicalEvent = {
        SourceMetadataSnapshot: {
          metadataEpoch: snapshot.metadataEpoch,
          revision: snapshot.revision,
          snapshotId,
          chunkIndex: 0xffff,
          totalChunks: 0xffff,
          records: candidate,
        },
      };
      if (this.eventFits(event)) {
        current = candidate;
        continue;
      }
      if (current.length === 0) {
        this.sendError(
          null,
          wsBorsh.ERROR_FRAME_TOO_LARGE,
          'metadata record exceeds frame limit',
          false
        );
        return null;
      }
      chunks.push(current);
      current = [record];
      const single = {
        SourceMetadataSnapshot: {
          metadataEpoch: snapshot.metadataEpoch,
          revision: snapshot.revision,
          snapshotId,
          chunkIndex: 0xffff,
          totalChunks: 0xffff,
          records: current,
        },
      } satisfies CanonicalEvent;
      if (!this.eventFits(single)) {
        this.sendError(
          null,
          wsBorsh.ERROR_FRAME_TOO_LARGE,
          'metadata record exceeds frame limit',
          false
        );
        return null;
      }
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  private maxPaneDataBytes(target: CanonicalPaneTarget, paneEpoch: Uint8Array): number {
    return this.maxVariableDataBytes((data) => ({
      PaneData: {
        pane: target,
        paneEpoch,
        seqStart: 0n,
        seqEnd: BigInt(data.byteLength),
        data,
      },
    }));
  }

  private maxContentChunkBytes(kind: 'screen' | 'history', requestId: Uint8Array): number {
    return this.maxVariableDataBytes((data) =>
      kind === 'screen'
        ? { ScreenChunk: { requestId, offset: 0, data } }
        : { HistoryChunk: { requestId, offset: 0, data } }
    );
  }

  private maxVariableDataBytes(build: (data: Uint8Array) => CanonicalEvent): number {
    let low = 0;
    let high = this.maxFrameBytes;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.eventFits(build(new Uint8Array(middle)))) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  private eventFits(event: CanonicalEvent): boolean {
    try {
      return (
        wsBorsh.encodeCanonicalEventPayload(event).byteLength + ENVELOPE_BYTES <= this.maxFrameBytes
      );
    } catch {
      return false;
    }
  }

  private send(event: CanonicalEvent): boolean {
    return this.sendBatch([event]);
  }

  private sendBatch(events: CanonicalEvent[]): boolean {
    if (this.closed || events.length === 0 || events.some((event) => !this.eventFits(event))) {
      return false;
    }
    return this.options.sendEvents(events);
  }

  private sendError(
    requestId: Uint8Array | null,
    code: number,
    message: string,
    retryable: boolean
  ): void {
    this.send({
      Error: {
        requestId: requestId ? copyBytes(requestId) : null,
        code,
        message: message.slice(0, 512),
        retryable,
      },
    });
  }
}
