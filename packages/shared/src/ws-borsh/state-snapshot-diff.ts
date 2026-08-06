import type { b } from '@zorsh/zorsh';
import type { StateSnapshotPayload, TmuxPane, TmuxSession, TmuxWindow } from '../index';
import {
  SOURCE_ENTITY_PANE,
  SOURCE_ENTITY_SESSION,
  SOURCE_ENTITY_WINDOW,
  SOURCE_FIELD_ACTIVE,
  SOURCE_FIELD_CURRENT_COMMAND,
  SOURCE_FIELD_CURRENT_PATH,
  SOURCE_FIELD_CUSTOM_NAME,
  SOURCE_FIELD_HEIGHT,
  SOURCE_FIELD_INDEX,
  SOURCE_FIELD_LAYOUT,
  SOURCE_FIELD_LEFT,
  SOURCE_FIELD_NAME,
  SOURCE_FIELD_PANE_EPOCH,
  SOURCE_FIELD_TITLE,
  SOURCE_FIELD_TOP,
  SOURCE_FIELD_WIDTH,
  type SourceMetadataPatchSchema,
} from './canonical-state';

export const STATE_SNAPSHOT_DIFF_FORMAT_ABSOLUTE_JSON = 1;
const MAX_DIFF_ENTITIES = 4_096;
const MAX_DIFF_FIELDS = 64;

export type LegacyMetadataFieldValue = string | number | boolean | null;

export interface LegacyMetadataEntityDiff {
  entityKind: number;
  nativeId: string;
  parentKind: number | null;
  parentId: string | null;
  fields: Array<[number, LegacyMetadataFieldValue]>;
}

export interface LegacyStateSnapshotDiff {
  upserts: LegacyMetadataEntityDiff[];
  removals: Array<{ entityKind: number; nativeId: string }>;
}

type SourceMetadataPatch = b.infer<typeof SourceMetadataPatchSchema>;

function wireValue(value: SourceMetadataPatch['upserts'][number]['fields'][number]['value']) {
  if ('String' in value) return value.String;
  if ('Bool' in value) return value.Bool;
  if ('U16' in value) return value.U16;
  if ('U32' in value) return value.U32;
  if ('Unset' in value) return null;
  return undefined;
}

export function sourceMetadataPatchToLegacyDiff(
  patch: SourceMetadataPatch
): LegacyStateSnapshotDiff {
  const upserts: LegacyMetadataEntityDiff[] = [];
  for (const record of patch.upserts) {
    if (
      record.key.entityKind !== SOURCE_ENTITY_SESSION &&
      record.key.entityKind !== SOURCE_ENTITY_WINDOW &&
      record.key.entityKind !== SOURCE_ENTITY_PANE
    ) {
      continue;
    }
    const fields: Array<[number, LegacyMetadataFieldValue]> = [];
    for (const field of record.fields) {
      if (field.field === SOURCE_FIELD_PANE_EPOCH) continue;
      const value = wireValue(field.value);
      if (value !== undefined) fields.push([field.field, value]);
    }
    upserts.push({
      entityKind: record.key.entityKind,
      nativeId: record.key.nativeId,
      parentKind: record.parent?.entityKind ?? null,
      parentId: record.parent?.nativeId ?? null,
      fields,
    });
  }
  return {
    upserts,
    removals: patch.removals
      .filter(
        (key) =>
          key.entityKind === SOURCE_ENTITY_SESSION ||
          key.entityKind === SOURCE_ENTITY_WINDOW ||
          key.entityKind === SOURCE_ENTITY_PANE
      )
      .map((key) => ({ entityKind: key.entityKind, nativeId: key.nativeId })),
  };
}

export function encodeLegacyStateSnapshotDiff(diff: LegacyStateSnapshotDiff): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(diff));
}

export function decodeLegacyStateSnapshotDiff(data: Uint8Array): LegacyStateSnapshotDiff {
  const decoded = JSON.parse(new TextDecoder().decode(data)) as Partial<LegacyStateSnapshotDiff>;
  if (!Array.isArray(decoded.upserts) || !Array.isArray(decoded.removals)) {
    throw new Error('invalid state snapshot diff');
  }
  if (decoded.upserts.length > MAX_DIFF_ENTITIES || decoded.removals.length > MAX_DIFF_ENTITIES) {
    throw new Error('state snapshot diff entity limit exceeded');
  }
  for (const upsert of decoded.upserts) {
    if (
      !upsert ||
      typeof upsert.nativeId !== 'string' ||
      typeof upsert.entityKind !== 'number' ||
      !Array.isArray(upsert.fields) ||
      upsert.fields.length > MAX_DIFF_FIELDS
    ) {
      throw new Error('invalid state snapshot upsert');
    }
  }
  for (const removal of decoded.removals) {
    if (
      !removal ||
      typeof removal.nativeId !== 'string' ||
      typeof removal.entityKind !== 'number'
    ) {
      throw new Error('invalid state snapshot removal');
    }
  }
  return decoded as LegacyStateSnapshotDiff;
}

function assignOptional<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | null
): void {
  if (value === null) delete target[key];
  else target[key] = value;
}

function applySessionFields(
  session: TmuxSession,
  fields: LegacyMetadataEntityDiff['fields']
): void {
  for (const [field, value] of fields) {
    if (field === SOURCE_FIELD_NAME && typeof value === 'string') session.name = value;
  }
}

function applyWindowFields(window: TmuxWindow, fields: LegacyMetadataEntityDiff['fields']): void {
  for (const [field, value] of fields) {
    if (field === SOURCE_FIELD_NAME && typeof value === 'string') window.name = value;
    else if (field === SOURCE_FIELD_INDEX && typeof value === 'number') window.index = value;
    else if (field === SOURCE_FIELD_ACTIVE && typeof value === 'boolean') window.active = value;
    else if (field === SOURCE_FIELD_LAYOUT && (typeof value === 'string' || value === null)) {
      assignOptional(window, 'layout', value);
    } else if (
      field === SOURCE_FIELD_CUSTOM_NAME &&
      (typeof value === 'string' || value === null)
    ) {
      assignOptional(window, 'customName', value);
    }
  }
}

function applyPaneFields(pane: TmuxPane, fields: LegacyMetadataEntityDiff['fields']): void {
  for (const [field, value] of fields) {
    if (field === SOURCE_FIELD_INDEX && typeof value === 'number') pane.index = value;
    else if (field === SOURCE_FIELD_ACTIVE && typeof value === 'boolean') pane.active = value;
    else if (field === SOURCE_FIELD_WIDTH && typeof value === 'number') pane.width = value;
    else if (field === SOURCE_FIELD_HEIGHT && typeof value === 'number') pane.height = value;
    else if (field === SOURCE_FIELD_LEFT && (typeof value === 'number' || value === null)) {
      assignOptional(pane, 'left', value);
    } else if (field === SOURCE_FIELD_TOP && (typeof value === 'number' || value === null)) {
      assignOptional(pane, 'top', value);
    } else if (field === SOURCE_FIELD_TITLE && (typeof value === 'string' || value === null)) {
      assignOptional(pane, 'title', value);
    } else if (
      field === SOURCE_FIELD_CURRENT_PATH &&
      (typeof value === 'string' || value === null)
    ) {
      assignOptional(pane, 'currentPath', value);
    } else if (
      field === SOURCE_FIELD_CURRENT_COMMAND &&
      (typeof value === 'string' || value === null)
    ) {
      assignOptional(pane, 'currentCommand', value);
    } else if (
      field === SOURCE_FIELD_CUSTOM_NAME &&
      (typeof value === 'string' || value === null)
    ) {
      assignOptional(pane, 'customName', value);
    }
  }
}

export function applyLegacyStateSnapshotDiff(
  snapshot: StateSnapshotPayload,
  diff: LegacyStateSnapshotDiff
): StateSnapshotPayload {
  let session = snapshot.session
    ? {
        ...snapshot.session,
        windows: snapshot.session.windows.map((window) => ({
          ...window,
          panes: window.panes.map((pane) => ({ ...pane })),
        })),
      }
    : null;

  for (const removal of diff.removals) {
    if (removal.entityKind === SOURCE_ENTITY_SESSION && session?.id === removal.nativeId) {
      session = null;
    } else if (removal.entityKind === SOURCE_ENTITY_WINDOW && session) {
      session.windows = session.windows.filter((window) => window.id !== removal.nativeId);
    } else if (removal.entityKind === SOURCE_ENTITY_PANE && session) {
      session.windows = session.windows.map((window) => ({
        ...window,
        panes: window.panes.filter((pane) => pane.id !== removal.nativeId),
      }));
    }
  }

  for (const upsert of diff.upserts) {
    if (upsert.entityKind !== SOURCE_ENTITY_SESSION) continue;
    if (!session || session.id !== upsert.nativeId) {
      session = { id: upsert.nativeId, name: '', windows: [] };
    }
    applySessionFields(session, upsert.fields);
  }

  for (const upsert of diff.upserts) {
    if (upsert.entityKind !== SOURCE_ENTITY_WINDOW || !session) continue;
    let window = session.windows.find((candidate) => candidate.id === upsert.nativeId);
    if (!window) {
      window = { id: upsert.nativeId, name: '', index: 0, active: false, panes: [] };
      session.windows.push(window);
    }
    applyWindowFields(window, upsert.fields);
  }

  for (const upsert of diff.upserts) {
    if (upsert.entityKind !== SOURCE_ENTITY_PANE || !upsert.parentId || !session) continue;
    const destination = session.windows.find((window) => window.id === upsert.parentId);
    if (!destination) continue;
    let pane: TmuxPane | undefined;
    for (const window of session.windows) {
      const index = window.panes.findIndex((candidate) => candidate.id === upsert.nativeId);
      if (index < 0) continue;
      pane = window.panes[index];
      if (window !== destination) window.panes.splice(index, 1);
      break;
    }
    if (!pane) {
      pane = {
        id: upsert.nativeId,
        windowId: destination.id,
        index: 0,
        active: false,
        width: 1,
        height: 1,
      };
    }
    pane.windowId = destination.id;
    if (!destination.panes.some((candidate) => candidate.id === pane?.id)) {
      destination.panes.push(pane);
    }
    applyPaneFields(pane, upsert.fields);
  }

  return { deviceId: snapshot.deviceId, session };
}
