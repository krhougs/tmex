import {
  type StateSnapshotPayload,
  collectLayoutLeaves,
  layoutLeafPaneId,
  parseWindowLayout,
  wsBorsh,
} from '@tmex/shared';

import type { TmuxSourceMetadataEvent } from './events';

const DEFAULT_FLUSH_INTERVAL_MS = 8;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const MAX_UNKNOWN_PANES = 256;
const MAX_UNKNOWN_PANE_BYTES = 256 * 1024;
const SERVER_NATIVE_ID = 'server';

type MetadataValue = wsBorsh.SourceMetadataValue;

interface FieldState {
  value: MetadataValue;
  revision: bigint;
}

interface ProjectedRecord {
  key: wsBorsh.SourceEntityKey;
  parent: wsBorsh.SourceEntityKey | null;
  parentRevision: bigint;
  entityRevision: bigint;
  fields: Map<number, FieldState>;
}

interface PendingUpsert {
  key: wsBorsh.SourceEntityKey;
  parent: wsBorsh.SourceEntityKey | null;
  fields: Map<number, MetadataValue>;
}

interface PaneFieldHints {
  title?: string;
  currentPath?: string;
  currentCommand?: string;
}

export interface MetadataProjectionSnapshot {
  metadataEpoch: Uint8Array;
  revision: bigint;
  records: wsBorsh.SourceMetadataRecord[];
}

export interface MetadataProjectionPatch {
  metadataEpoch: Uint8Array;
  fromRevision: bigint;
  throughRevision: bigint;
  upserts: wsBorsh.SourceMetadataRecord[];
  removals: wsBorsh.SourceEntityKey[];
}

export interface MetadataProjectionOptions {
  deviceName?: string;
  flushIntervalMs?: number;
  createEpoch?: () => Uint8Array;
  onPatch?: (patch: MetadataProjectionPatch) => void;
  onRebaseRequired?: (snapshot: MetadataProjectionSnapshot) => void;
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

function cloneKey(key: wsBorsh.SourceEntityKey): wsBorsh.SourceEntityKey {
  return { ...key, serverEpoch: copyBytes(key.serverEpoch) };
}

function keyId(key: Pick<wsBorsh.SourceEntityKey, 'entityKind' | 'nativeId'>): string {
  return `${key.entityKind}\0${key.nativeId}`;
}

function cloneValue(value: MetadataValue): MetadataValue {
  if ('Bytes16' in value) return { Bytes16: copyBytes(value.Bytes16) };
  if ('String' in value) return { String: value.String };
  if ('Bool' in value) return { Bool: value.Bool };
  if ('U16' in value) return { U16: value.U16 };
  if ('U32' in value) return { U32: value.U32 };
  return { Unset: {} };
}

function valueEqual(left: MetadataValue | undefined, right: MetadataValue | undefined): boolean {
  if (!left || !right) return left === right;
  if ('Bytes16' in left && 'Bytes16' in right) return bytesEqual(left.Bytes16, right.Bytes16);
  if ('String' in left && 'String' in right) return left.String === right.String;
  if ('Bool' in left && 'Bool' in right) return left.Bool === right.Bool;
  if ('U16' in left && 'U16' in right) return left.U16 === right.U16;
  if ('U32' in left && 'U32' in right) return left.U32 === right.U32;
  return 'Unset' in left && 'Unset' in right;
}

function keyEqual(
  left: wsBorsh.SourceEntityKey | null,
  right: wsBorsh.SourceEntityKey | null
): boolean {
  if (!left || !right) return left === right;
  return (
    left.deviceId === right.deviceId &&
    left.entityKind === right.entityKind &&
    left.nativeId === right.nativeId &&
    bytesEqual(left.serverEpoch, right.serverEpoch)
  );
}

function stringValue(value: string): MetadataValue {
  return { String: value };
}

function boolValue(value: boolean): MetadataValue {
  return { Bool: value };
}

function u16Value(value: number): MetadataValue {
  return { U16: value };
}

function u32Value(value: number): MetadataValue {
  return { U32: value };
}

function estimateKeyBytes(key: wsBorsh.SourceEntityKey): number {
  return 32 + key.deviceId.length * 3 + key.nativeId.length * 3;
}

function estimateUpsertBytes(upsert: PendingUpsert): number {
  let bytes = estimateKeyBytes(upsert.key) + (upsert.parent ? estimateKeyBytes(upsert.parent) : 1);
  for (const value of upsert.fields.values()) {
    bytes += 8;
    if ('String' in value) bytes += value.String.length * 3;
    if ('Bytes16' in value) bytes += 16;
  }
  return bytes;
}

export class MetadataProjection {
  private metadataEpochValue: Uint8Array;
  private serverEpochValue: Uint8Array | null = null;
  private revisionValue = 0n;
  private readonly records = new Map<string, ProjectedRecord>();
  private readonly removedAt = new Map<string, bigint>();
  private readonly paneEpochs = new Map<string, Uint8Array>();
  private readonly unknownPaneHints = new Map<string, PaneFieldHints>();
  private unknownPaneBytes = 0;
  private readonly windowCustomNames = new Map<string, string>();
  private readonly paneCustomNames = new Map<string, string>();
  private readonly dirtyUpserts = new Map<string, PendingUpsert>();
  private readonly dirtyRemovals = new Map<string, wsBorsh.SourceEntityKey>();
  private dirtyFromRevision: bigint | null = null;
  private dirtyBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private established = false;
  private disposed = false;
  private readonly flushIntervalMs: number;
  private readonly deviceName: string;
  private readonly createEpoch: () => Uint8Array;
  private readonly onPatch?: (patch: MetadataProjectionPatch) => void;
  private readonly onRebaseRequired?: (snapshot: MetadataProjectionSnapshot) => void;

  constructor(
    readonly deviceId: string,
    options: MetadataProjectionOptions = {}
  ) {
    this.deviceName = options.deviceName?.trim() || deviceId;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.createEpoch = options.createEpoch ?? defaultCreateEpoch;
    this.metadataEpochValue = copyBytes(this.createEpoch());
    this.onPatch = options.onPatch;
    this.onRebaseRequired = options.onRebaseRequired;
  }

  get revision(): bigint {
    return this.revisionValue;
  }

  get metadataEpoch(): Uint8Array {
    return copyBytes(this.metadataEpochValue);
  }

  get serverEpoch(): Uint8Array | null {
    return this.serverEpochValue ? copyBytes(this.serverEpochValue) : null;
  }

  getPaneEpoch(paneId: string): Uint8Array | null {
    const paneEpoch = this.paneEpochs.get(paneId);
    return paneEpoch ? copyBytes(paneEpoch) : null;
  }

  ensurePaneEpoch(paneId: string): Uint8Array | null {
    if (!this.serverEpochValue) return null;
    const existing = this.paneEpochs.get(paneId);
    if (existing) return copyBytes(existing);
    const paneEpoch = copyBytes(this.createEpoch());
    this.paneEpochs.set(paneId, paneEpoch);
    return copyBytes(paneEpoch);
  }

  hasPane(paneId: string): boolean {
    return this.records.has(keyId({ entityKind: wsBorsh.SOURCE_ENTITY_PANE, nativeId: paneId }));
  }

  setServerEpoch(serverEpoch: Uint8Array): void {
    if (serverEpoch.byteLength !== 16) throw new Error('server epoch must be 16 bytes');
    if (this.serverEpochValue && bytesEqual(this.serverEpochValue, serverEpoch)) return;

    const wasEstablished = this.established;
    this.clearPending();
    this.records.clear();
    this.removedAt.clear();
    this.paneEpochs.clear();
    this.unknownPaneHints.clear();
    this.unknownPaneBytes = 0;
    this.serverEpochValue = copyBytes(serverEpoch);
    this.metadataEpochValue = copyBytes(this.createEpoch());
    this.revisionValue = 0n;
    this.established = false;
    if (wasEstablished) this.onRebaseRequired?.(this.currentSnapshot());
  }

  currentSnapshot(): MetadataProjectionSnapshot {
    return {
      metadataEpoch: this.metadataEpoch,
      revision: this.revisionValue,
      records: Array.from(this.records.values(), (record) => this.toWireRecord(record)),
    };
  }

  reconcile(snapshot: StateSnapshotPayload, baseRevision = this.revisionValue): void {
    if (this.disposed || !this.serverEpochValue) return;
    const desired = this.buildDesired(snapshot);

    if (!this.established) {
      const revision = 1n;
      this.records.clear();
      for (const [id, record] of desired) {
        this.records.set(id, this.createRecord(record, revision));
      }
      this.revisionValue = revision;
      this.established = true;
      return;
    }

    const changes: Array<() => void> = [];
    const nextRevision = this.revisionValue + 1n;

    for (const [id, wanted] of desired) {
      const current = this.records.get(id);
      if (!current) {
        if ((this.removedAt.get(id) ?? -1n) > baseRevision) continue;
        changes.push(() => {
          const created = this.createRecord(wanted, nextRevision);
          this.records.set(id, created);
          this.removedAt.delete(id);
          this.markFullUpsert(created);
        });
        continue;
      }

      const fieldChanges: Array<[number, MetadataValue | null]> = [];
      let parentChanged = false;
      if (current.parentRevision <= baseRevision && !keyEqual(current.parent, wanted.parent)) {
        parentChanged = true;
      }

      const wantedFields = wanted.fields;
      const allFieldIds = new Set([...current.fields.keys(), ...wantedFields.keys()]);
      for (const fieldId of allFieldIds) {
        if (fieldId === wsBorsh.SOURCE_FIELD_CUSTOM_NAME && !wantedFields.has(fieldId)) continue;
        const previous = current.fields.get(fieldId);
        if (previous && previous.revision > baseRevision) continue;
        const wantedValue = wantedFields.get(fieldId);
        if (!valueEqual(previous?.value, wantedValue)) {
          fieldChanges.push([fieldId, wantedValue ?? null]);
        }
      }

      if (!parentChanged && fieldChanges.length === 0) continue;
      changes.push(() => {
        current.entityRevision = nextRevision;
        if (parentChanged) {
          current.parent = wanted.parent ? cloneKey(wanted.parent) : null;
          current.parentRevision = nextRevision;
          this.markUpsert(current);
        }
        for (const [fieldId, value] of fieldChanges) {
          this.setRecordField(current, fieldId, value, nextRevision);
        }
      });
    }

    for (const [id, current] of this.records) {
      if (desired.has(id) || current.entityRevision > baseRevision) continue;
      changes.push(() => this.removeRecord(current, nextRevision));
    }

    if (changes.length === 0) return;
    this.beginDirtyRevision();
    this.revisionValue = nextRevision;
    for (const apply of changes) apply();
    this.finishMutation();
  }

  applySourceEvent(event: TmuxSourceMetadataEvent): void {
    if (this.disposed || !this.established) {
      if (event.type === 'pane-title')
        this.rememberUnknownPane(event.paneId, { title: event.title });
      if (event.type === 'pane-current-path') {
        this.rememberUnknownPane(event.paneId, { currentPath: event.currentPath });
      }
      if (event.type === 'pane-current-command') {
        this.rememberUnknownPane(event.paneId, { currentCommand: event.currentCommand });
      }
      return;
    }

    const nextRevision = this.revisionValue + 1n;
    const actions: Array<() => void> = [];
    const setField = (kind: number, nativeId: string, field: number, value: MetadataValue) => {
      const record = this.records.get(keyId({ entityKind: kind, nativeId }));
      if (!record) return false;
      if (valueEqual(record.fields.get(field)?.value, value)) return true;
      actions.push(() => this.setRecordField(record, field, value, nextRevision));
      return true;
    };

    switch (event.type) {
      case 'pane-title':
        if (
          !setField(
            wsBorsh.SOURCE_ENTITY_PANE,
            event.paneId,
            wsBorsh.SOURCE_FIELD_TITLE,
            stringValue(event.title)
          )
        ) {
          this.rememberUnknownPane(event.paneId, { title: event.title });
        }
        break;
      case 'pane-current-path':
        if (
          !setField(
            wsBorsh.SOURCE_ENTITY_PANE,
            event.paneId,
            wsBorsh.SOURCE_FIELD_CURRENT_PATH,
            stringValue(event.currentPath)
          )
        ) {
          this.rememberUnknownPane(event.paneId, { currentPath: event.currentPath });
        }
        break;
      case 'pane-current-command':
        if (
          !setField(
            wsBorsh.SOURCE_ENTITY_PANE,
            event.paneId,
            wsBorsh.SOURCE_FIELD_CURRENT_COMMAND,
            stringValue(event.currentCommand)
          )
        ) {
          this.rememberUnknownPane(event.paneId, { currentCommand: event.currentCommand });
        }
        break;
      case 'session-renamed':
        setField(
          wsBorsh.SOURCE_ENTITY_SESSION,
          event.sessionId,
          wsBorsh.SOURCE_FIELD_NAME,
          stringValue(event.name)
        );
        break;
      case 'window-renamed':
        setField(
          wsBorsh.SOURCE_ENTITY_WINDOW,
          event.windowId,
          wsBorsh.SOURCE_FIELD_NAME,
          stringValue(event.name)
        );
        break;
      case 'session-window-changed':
        this.queueActiveChild(
          actions,
          wsBorsh.SOURCE_ENTITY_WINDOW,
          event.sessionId,
          event.windowId,
          nextRevision
        );
        break;
      case 'window-pane-changed':
        this.queueActiveChild(
          actions,
          wsBorsh.SOURCE_ENTITY_PANE,
          event.windowId,
          event.paneId,
          nextRevision
        );
        break;
      case 'layout-change': {
        setField(
          wsBorsh.SOURCE_ENTITY_WINDOW,
          event.windowId,
          wsBorsh.SOURCE_FIELD_LAYOUT,
          stringValue(event.layout)
        );
        const parsed = parseWindowLayout(event.layout);
        if (parsed) {
          for (const leaf of collectLayoutLeaves(parsed.root)) {
            const paneId = layoutLeafPaneId(leaf);
            setField(
              wsBorsh.SOURCE_ENTITY_PANE,
              paneId,
              wsBorsh.SOURCE_FIELD_WIDTH,
              u16Value(leaf.width)
            );
            setField(
              wsBorsh.SOURCE_ENTITY_PANE,
              paneId,
              wsBorsh.SOURCE_FIELD_HEIGHT,
              u16Value(leaf.height)
            );
            setField(
              wsBorsh.SOURCE_ENTITY_PANE,
              paneId,
              wsBorsh.SOURCE_FIELD_LEFT,
              u16Value(leaf.x)
            );
            setField(
              wsBorsh.SOURCE_ENTITY_PANE,
              paneId,
              wsBorsh.SOURCE_FIELD_TOP,
              u16Value(leaf.y)
            );
          }
        }
        break;
      }
      case 'window-close': {
        const record = this.records.get(
          keyId({ entityKind: wsBorsh.SOURCE_ENTITY_WINDOW, nativeId: event.windowId })
        );
        if (record) actions.push(() => this.removeRecord(record, nextRevision));
        break;
      }
    }

    if (actions.length === 0) return;
    this.beginDirtyRevision();
    this.revisionValue = nextRevision;
    for (const action of actions) action();
    this.finishMutation();
  }

  customNameOf(kind: 'window' | 'pane', nativeId: string): string | undefined {
    const names = kind === 'window' ? this.windowCustomNames : this.paneCustomNames;
    return names.get(nativeId);
  }

  setCustomName(kind: 'window' | 'pane', nativeId: string, name: string | null): void {
    const names = kind === 'window' ? this.windowCustomNames : this.paneCustomNames;
    if (name) names.set(nativeId, name);
    else names.delete(nativeId);

    const entityKind =
      kind === 'window' ? wsBorsh.SOURCE_ENTITY_WINDOW : wsBorsh.SOURCE_ENTITY_PANE;
    const record = this.records.get(keyId({ entityKind, nativeId }));
    if (!record) return;
    const previous = record.fields.get(wsBorsh.SOURCE_FIELD_CUSTOM_NAME)?.value;
    const value = name ? stringValue(name) : null;
    if (valueEqual(previous, value ?? undefined)) return;

    const nextRevision = this.revisionValue + 1n;
    this.beginDirtyRevision();
    this.revisionValue = nextRevision;
    this.setRecordField(record, wsBorsh.SOURCE_FIELD_CUSTOM_NAME, value, nextRevision);
    this.finishMutation();
  }

  flushPending(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirtyFromRevision === null) return;

    const patch: MetadataProjectionPatch = {
      metadataEpoch: this.metadataEpoch,
      fromRevision: this.dirtyFromRevision,
      throughRevision: this.revisionValue,
      upserts: Array.from(this.dirtyUpserts.values(), (upsert) => ({
        key: cloneKey(upsert.key),
        parent: upsert.parent ? cloneKey(upsert.parent) : null,
        fields: Array.from(upsert.fields, ([field, value]) => ({
          field,
          value: cloneValue(value),
        })).sort((left, right) => left.field - right.field),
      })),
      removals: Array.from(this.dirtyRemovals.values(), cloneKey),
    };
    this.clearPending();

    try {
      wsBorsh.encodeCanonicalEventPayload({ SourceMetadataPatch: patch });
    } catch (error) {
      if (error instanceof wsBorsh.WsBorshError && error.code === wsBorsh.ERROR_FRAME_TOO_LARGE) {
        this.onRebaseRequired?.(this.currentSnapshot());
        return;
      }
      throw error;
    }
    this.onPatch?.(patch);
  }

  dispose(): void {
    this.disposed = true;
    this.clearPending();
    this.records.clear();
    this.unknownPaneHints.clear();
  }

  private buildDesired(snapshot: StateSnapshotPayload): Map<string, PendingUpsert> {
    const desired = new Map<string, PendingUpsert>();
    const device = this.newRecord(wsBorsh.SOURCE_ENTITY_DEVICE, this.deviceId, null);
    device.fields.set(wsBorsh.SOURCE_FIELD_NAME, stringValue(this.deviceName));
    device.fields.set(wsBorsh.SOURCE_FIELD_CONNECTED, boolValue(true));
    desired.set(keyId(device.key), device);

    const server = this.newRecord(wsBorsh.SOURCE_ENTITY_SERVER, SERVER_NATIVE_ID, device.key);
    server.fields.set(wsBorsh.SOURCE_FIELD_CONNECTED, boolValue(true));
    desired.set(keyId(server.key), server);
    if (!snapshot.session) return desired;

    const session = this.newRecord(wsBorsh.SOURCE_ENTITY_SESSION, snapshot.session.id, server.key);
    session.fields.set(wsBorsh.SOURCE_FIELD_NAME, stringValue(snapshot.session.name));
    desired.set(keyId(session.key), session);

    for (const window of snapshot.session.windows) {
      const windowRecord = this.newRecord(wsBorsh.SOURCE_ENTITY_WINDOW, window.id, session.key);
      windowRecord.fields.set(wsBorsh.SOURCE_FIELD_NAME, stringValue(window.name));
      windowRecord.fields.set(wsBorsh.SOURCE_FIELD_INDEX, u32Value(window.index));
      windowRecord.fields.set(wsBorsh.SOURCE_FIELD_ACTIVE, boolValue(window.active));
      if (window.layout !== undefined) {
        windowRecord.fields.set(wsBorsh.SOURCE_FIELD_LAYOUT, stringValue(window.layout));
      }
      const windowCustomName = this.windowCustomNames.get(window.id) ?? window.customName;
      if (windowCustomName) {
        windowRecord.fields.set(wsBorsh.SOURCE_FIELD_CUSTOM_NAME, stringValue(windowCustomName));
      }
      desired.set(keyId(windowRecord.key), windowRecord);

      for (const pane of window.panes) {
        const paneRecord = this.newRecord(wsBorsh.SOURCE_ENTITY_PANE, pane.id, windowRecord.key);
        paneRecord.fields.set(wsBorsh.SOURCE_FIELD_INDEX, u32Value(pane.index));
        paneRecord.fields.set(wsBorsh.SOURCE_FIELD_ACTIVE, boolValue(pane.active));
        paneRecord.fields.set(wsBorsh.SOURCE_FIELD_WIDTH, u16Value(pane.width));
        paneRecord.fields.set(wsBorsh.SOURCE_FIELD_HEIGHT, u16Value(pane.height));
        if (pane.left !== undefined)
          paneRecord.fields.set(wsBorsh.SOURCE_FIELD_LEFT, u16Value(pane.left));
        if (pane.top !== undefined)
          paneRecord.fields.set(wsBorsh.SOURCE_FIELD_TOP, u16Value(pane.top));
        if (pane.title !== undefined)
          paneRecord.fields.set(wsBorsh.SOURCE_FIELD_TITLE, stringValue(pane.title));
        if (pane.currentPath !== undefined) {
          paneRecord.fields.set(wsBorsh.SOURCE_FIELD_CURRENT_PATH, stringValue(pane.currentPath));
        }
        if (pane.currentCommand !== undefined) {
          paneRecord.fields.set(
            wsBorsh.SOURCE_FIELD_CURRENT_COMMAND,
            stringValue(pane.currentCommand)
          );
        }
        const paneEpoch = this.ensurePaneEpoch(pane.id);
        if (!paneEpoch) throw new Error('server epoch must be established before pane projection');
        paneRecord.fields.set(wsBorsh.SOURCE_FIELD_PANE_EPOCH, { Bytes16: copyBytes(paneEpoch) });
        const paneCustomName = this.paneCustomNames.get(pane.id) ?? pane.customName;
        if (paneCustomName) {
          paneRecord.fields.set(wsBorsh.SOURCE_FIELD_CUSTOM_NAME, stringValue(paneCustomName));
        }
        const hints = this.unknownPaneHints.get(pane.id);
        if (hints?.title !== undefined) {
          paneRecord.fields.set(wsBorsh.SOURCE_FIELD_TITLE, stringValue(hints.title));
        }
        if (hints?.currentPath !== undefined) {
          paneRecord.fields.set(wsBorsh.SOURCE_FIELD_CURRENT_PATH, stringValue(hints.currentPath));
        }
        if (hints?.currentCommand !== undefined) {
          paneRecord.fields.set(
            wsBorsh.SOURCE_FIELD_CURRENT_COMMAND,
            stringValue(hints.currentCommand)
          );
        }
        if (hints) this.deleteUnknownPane(pane.id);
        desired.set(keyId(paneRecord.key), paneRecord);
      }
    }
    return desired;
  }

  private newRecord(
    entityKind: number,
    nativeId: string,
    parent: wsBorsh.SourceEntityKey | null
  ): PendingUpsert {
    if (!this.serverEpochValue) throw new Error('server epoch is not ready');
    return {
      key: {
        deviceId: this.deviceId,
        serverEpoch: copyBytes(this.serverEpochValue),
        entityKind,
        nativeId,
      },
      parent: parent ? cloneKey(parent) : null,
      fields: new Map(),
    };
  }

  private createRecord(source: PendingUpsert, revision: bigint): ProjectedRecord {
    return {
      key: cloneKey(source.key),
      parent: source.parent ? cloneKey(source.parent) : null,
      parentRevision: revision,
      entityRevision: revision,
      fields: new Map(
        Array.from(source.fields, ([field, value]) => [
          field,
          { value: cloneValue(value), revision },
        ])
      ),
    };
  }

  private toWireRecord(record: ProjectedRecord): wsBorsh.SourceMetadataRecord {
    return {
      key: cloneKey(record.key),
      parent: record.parent ? cloneKey(record.parent) : null,
      fields: Array.from(record.fields, ([field, state]) => ({
        field,
        value: cloneValue(state.value),
      })).sort((left, right) => left.field - right.field),
    };
  }

  private queueActiveChild(
    actions: Array<() => void>,
    childKind: number,
    parentNativeId: string,
    activeNativeId: string,
    revision: bigint
  ): void {
    for (const record of this.records.values()) {
      if (
        record.key.entityKind !== childKind ||
        record.parent?.nativeId !== parentNativeId ||
        record.parent.entityKind !== childKind - 1
      ) {
        continue;
      }
      const next = boolValue(record.key.nativeId === activeNativeId);
      if (valueEqual(record.fields.get(wsBorsh.SOURCE_FIELD_ACTIVE)?.value, next)) continue;
      actions.push(() => this.setRecordField(record, wsBorsh.SOURCE_FIELD_ACTIVE, next, revision));
    }
  }

  private setRecordField(
    record: ProjectedRecord,
    field: number,
    value: MetadataValue | null,
    revision: bigint
  ): void {
    record.entityRevision = revision;
    if (value) record.fields.set(field, { value: cloneValue(value), revision });
    else record.fields.delete(field);
    this.markUpsert(record, field, value ?? { Unset: {} });
  }

  private removeRecord(record: ProjectedRecord, revision: bigint): void {
    const descendants = Array.from(this.records.values()).filter(
      (candidate) => candidate.parent && keyEqual(candidate.parent, record.key)
    );
    for (const descendant of descendants) this.removeRecord(descendant, revision);

    const id = keyId(record.key);
    this.records.delete(id);
    this.removedAt.set(id, revision);
    this.paneEpochs.delete(record.key.nativeId);
    this.dirtyUpserts.delete(id);
    this.dirtyRemovals.set(id, cloneKey(record.key));
    this.recalculateDirtyBytes();
  }

  private markFullUpsert(record: ProjectedRecord): void {
    const upsert: PendingUpsert = {
      key: cloneKey(record.key),
      parent: record.parent ? cloneKey(record.parent) : null,
      fields: new Map(
        Array.from(record.fields, ([field, state]) => [field, cloneValue(state.value)])
      ),
    };
    const id = keyId(record.key);
    this.dirtyRemovals.delete(id);
    this.dirtyUpserts.set(id, upsert);
    this.recalculateDirtyBytes();
  }

  private markUpsert(record: ProjectedRecord, field?: number, value?: MetadataValue): void {
    const id = keyId(record.key);
    const upsert = this.dirtyUpserts.get(id) ?? {
      key: cloneKey(record.key),
      parent: record.parent ? cloneKey(record.parent) : null,
      fields: new Map<number, MetadataValue>(),
    };
    upsert.parent = record.parent ? cloneKey(record.parent) : null;
    if (field !== undefined && value) upsert.fields.set(field, cloneValue(value));
    this.dirtyRemovals.delete(id);
    this.dirtyUpserts.set(id, upsert);
    this.recalculateDirtyBytes();
  }

  private beginDirtyRevision(): void {
    if (this.dirtyFromRevision === null) this.dirtyFromRevision = this.revisionValue;
  }

  private finishMutation(): void {
    if (this.dirtyBytes > MAX_PENDING_BYTES) {
      this.clearPending();
      this.onRebaseRequired?.(this.currentSnapshot());
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushPending(), this.flushIntervalMs);
    }
  }

  private recalculateDirtyBytes(): void {
    this.dirtyBytes = 0;
    for (const upsert of this.dirtyUpserts.values()) this.dirtyBytes += estimateUpsertBytes(upsert);
    for (const removal of this.dirtyRemovals.values()) this.dirtyBytes += estimateKeyBytes(removal);
  }

  private rememberUnknownPane(paneId: string, fields: PaneFieldHints): void {
    const previous = this.unknownPaneHints.get(paneId) ?? {};
    const merged = { ...previous, ...fields };
    if (!this.unknownPaneHints.has(paneId) && this.unknownPaneHints.size >= MAX_UNKNOWN_PANES) {
      const oldest = this.unknownPaneHints.keys().next().value;
      if (oldest) this.deleteUnknownPane(oldest);
    }
    this.unknownPaneHints.set(paneId, merged);
    this.recalculateUnknownPaneBytes();
    while (this.unknownPaneBytes > MAX_UNKNOWN_PANE_BYTES) {
      const oldest = this.unknownPaneHints.keys().next().value;
      if (!oldest) break;
      this.deleteUnknownPane(oldest);
    }
  }

  private deleteUnknownPane(paneId: string): void {
    this.unknownPaneHints.delete(paneId);
    this.recalculateUnknownPaneBytes();
  }

  private recalculateUnknownPaneBytes(): void {
    this.unknownPaneBytes = 0;
    for (const [paneId, fields] of this.unknownPaneHints) {
      this.unknownPaneBytes += paneId.length * 3;
      this.unknownPaneBytes += (fields.title?.length ?? 0) * 3;
      this.unknownPaneBytes += (fields.currentPath?.length ?? 0) * 3;
      this.unknownPaneBytes += (fields.currentCommand?.length ?? 0) * 3;
    }
  }

  private clearPending(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.dirtyUpserts.clear();
    this.dirtyRemovals.clear();
    this.dirtyFromRevision = null;
    this.dirtyBytes = 0;
  }
}
