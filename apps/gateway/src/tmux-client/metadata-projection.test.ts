import { describe, expect, test } from 'bun:test';
import { type StateSnapshotPayload, wsBorsh } from '@tmex/shared';

import {
  MetadataProjection,
  type MetadataProjectionPatch,
  type MetadataProjectionSnapshot,
} from './metadata-projection';

const SERVER_EPOCH = Uint8Array.from({ length: 16 }, (_, index) => index);

function snapshot(title = 'shell'): StateSnapshotPayload {
  return {
    deviceId: 'device-a',
    session: {
      id: '$1',
      name: 'work',
      windows: [
        {
          id: '@1',
          name: 'main',
          index: 0,
          active: true,
          layout: 'b25d,80x24,0,0,1',
          panes: [
            {
              id: '%1',
              windowId: '@1',
              index: 0,
              title,
              currentPath: '/work',
              currentCommand: 'zsh',
              active: true,
              width: 80,
              height: 24,
              left: 0,
              top: 0,
            },
          ],
        },
      ],
    },
  };
}

function findRecord(
  value: MetadataProjectionSnapshot,
  kind: number,
  nativeId: string
): wsBorsh.SourceMetadataRecord {
  const record = value.records.find(
    (candidate) => candidate.key.entityKind === kind && candidate.key.nativeId === nativeId
  );
  if (!record) throw new Error(`record missing: ${kind}/${nativeId}`);
  return record;
}

function stringField(record: wsBorsh.SourceMetadataRecord, field: number): string | null {
  const value = record.fields.find((candidate) => candidate.field === field)?.value;
  return value && 'String' in value ? value.String : null;
}

function createProjection() {
  const patches: MetadataProjectionPatch[] = [];
  const rebases: MetadataProjectionSnapshot[] = [];
  let epoch = 10;
  const projection = new MetadataProjection('device-a', {
    deviceName: 'Developer Mac',
    createEpoch: () => new Uint8Array(16).fill(epoch++),
    onPatch: (patch) => patches.push(patch),
    onRebaseRequired: (value) => rebases.push(value),
  });
  projection.setServerEpoch(SERVER_EPOCH);
  return { projection, patches, rebases };
}

describe('runtime metadata projection', () => {
  test('establishes a full hierarchy once and identical reconciliation is a no-op', () => {
    const { projection, patches } = createProjection();
    projection.reconcile(snapshot());

    const current = projection.currentSnapshot();
    expect(current.revision).toBe(1n);
    expect(current.records.map((record) => record.key.entityKind)).toEqual([0, 1, 2, 3, 4]);
    expect(
      stringField(
        findRecord(current, wsBorsh.SOURCE_ENTITY_DEVICE, 'device-a'),
        wsBorsh.SOURCE_FIELD_NAME
      )
    ).toBe('Developer Mac');
    expect(
      stringField(findRecord(current, wsBorsh.SOURCE_ENTITY_PANE, '%1'), wsBorsh.SOURCE_FIELD_TITLE)
    ).toBe('shell');

    projection.reconcile(snapshot(), projection.revision);
    projection.flushPending();
    expect(projection.revision).toBe(1n);
    expect(patches).toEqual([]);
  });

  test('coalesces rapid titles into one latest-wins absolute patch', () => {
    const { projection, patches } = createProjection();
    projection.reconcile(snapshot());
    for (let index = 0; index < 100; index += 1) {
      projection.applySourceEvent({ type: 'pane-title', paneId: '%1', title: `title-${index}` });
    }
    projection.flushPending();

    expect(patches).toHaveLength(1);
    expect(patches[0]?.fromRevision).toBe(1n);
    expect(patches[0]?.throughRevision).toBe(101n);
    expect(patches[0]?.upserts).toHaveLength(1);
    const patch = patches[0];
    const upsert = patch?.upserts[0];
    if (!upsert) throw new Error('expected one metadata upsert');
    expect(stringField(upsert, wsBorsh.SOURCE_FIELD_TITLE)).toBe('title-99');
    expect(patches[0]?.removals).toEqual([]);
  });

  test('does not let a stale reconciliation overwrite newer output metadata', () => {
    const { projection, patches } = createProjection();
    projection.reconcile(snapshot('old'));
    const queryBase = projection.revision;
    projection.applySourceEvent({ type: 'pane-title', paneId: '%1', title: 'new' });
    projection.reconcile(snapshot('old'), queryBase);
    projection.flushPending();

    expect(projection.revision).toBe(2n);
    expect(patches).toHaveLength(1);
    expect(
      stringField(
        findRecord(projection.currentSnapshot(), wsBorsh.SOURCE_ENTITY_PANE, '%1'),
        wsBorsh.SOURCE_FIELD_TITLE
      )
    ).toBe('new');
  });

  test('buffers metadata for a pane observed before its structural snapshot', () => {
    const { projection } = createProjection();
    projection.applySourceEvent({ type: 'pane-title', paneId: '%1', title: 'early' });
    projection.reconcile(snapshot('stale'));

    expect(
      stringField(
        findRecord(projection.currentSnapshot(), wsBorsh.SOURCE_ENTITY_PANE, '%1'),
        wsBorsh.SOURCE_FIELD_TITLE
      )
    ).toBe('early');
  });

  test('emits window before pane when the pane was dirtied first', () => {
    const { projection, patches } = createProjection();
    projection.reconcile(snapshot());
    projection.applySourceEvent({ type: 'pane-current-path', paneId: '%1', currentPath: '/src' });
    projection.applySourceEvent({ type: 'window-renamed', windowId: '@1', name: 'renamed' });
    projection.flushPending();

    expect(patches).toHaveLength(1);
    expect(patches[0]?.upserts.map((record) => record.key.entityKind)).toEqual([
      wsBorsh.SOURCE_ENTITY_WINDOW,
      wsBorsh.SOURCE_ENTITY_PANE,
    ]);
  });

  test('removes a window subtree atomically and cancels tombstones when it reappears', () => {
    const { projection, patches } = createProjection();
    projection.reconcile(snapshot());
    projection.applySourceEvent({ type: 'window-close', windowId: '@1' });
    projection.reconcile(snapshot(), projection.revision);
    projection.flushPending();

    expect(patches).toHaveLength(1);
    expect(patches[0]?.removals).toEqual([]);
    expect(patches[0]?.upserts.map((record) => record.key.nativeId).sort()).toEqual(['%1', '@1']);
    expect(projection.currentSnapshot().records).toHaveLength(5);
  });

  test('emits Unset for removed optional fields and custom names stay projection-owned', () => {
    const { projection, patches } = createProjection();
    projection.reconcile(snapshot());
    projection.setCustomName('pane', '%1', 'mine');
    projection.setCustomName('pane', '%1', null);
    projection.flushPending();

    expect(patches).toHaveLength(1);
    const field = patches[0]?.upserts[0]?.fields.find(
      (candidate) => candidate.field === wsBorsh.SOURCE_FIELD_CUSTOM_NAME
    );
    expect(field?.value).toEqual({ Unset: {} });
  });
});
