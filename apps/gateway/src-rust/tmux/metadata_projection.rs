use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fmt;

use tmex_protocol::{
    encode_canonical_event, CanonicalEvent, ProtocolError, SourceEntityKey, SourceMetadataField,
    SourceMetadataPatch, SourceMetadataRecord, SourceMetadataValue, StateSnapshot, WireToken,
    SOURCE_ENTITY_DEVICE, SOURCE_ENTITY_PANE, SOURCE_ENTITY_SERVER, SOURCE_ENTITY_SESSION,
    SOURCE_ENTITY_WINDOW, SOURCE_FIELD_ACTIVE, SOURCE_FIELD_CONNECTED,
    SOURCE_FIELD_CURRENT_COMMAND, SOURCE_FIELD_CURRENT_PATH, SOURCE_FIELD_CUSTOM_NAME,
    SOURCE_FIELD_HEIGHT, SOURCE_FIELD_INDEX, SOURCE_FIELD_LAYOUT, SOURCE_FIELD_LEFT,
    SOURCE_FIELD_NAME, SOURCE_FIELD_PANE_EPOCH, SOURCE_FIELD_TITLE, SOURCE_FIELD_TOP,
    SOURCE_FIELD_WIDTH,
};

use super::SourceMetadataEvent;

pub const DEFAULT_METADATA_FLUSH_INTERVAL_MS: u64 = 8;
pub const MAX_PENDING_METADATA_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_UNKNOWN_PANES: usize = 256;
pub const MAX_UNKNOWN_PANE_BYTES: usize = 256 * 1024;
const SERVER_NATIVE_ID: &str = "server";

type RecordId = (u8, String);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProjectionEntityKind {
    Window,
    Pane,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MetadataProjectionSnapshot {
    pub metadata_epoch: WireToken,
    pub revision: u64,
    pub records: Vec<SourceMetadataRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MetadataProjectionFlush {
    Patch(SourceMetadataPatch),
    Rebase(MetadataProjectionSnapshot),
}

#[derive(Debug, PartialEq, Eq)]
pub enum MetadataProjectionError {
    RevisionOverflow,
    Protocol(ProtocolError),
}

impl fmt::Display for MetadataProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RevisionOverflow => formatter.write_str("metadata revision overflow"),
            Self::Protocol(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for MetadataProjectionError {}

#[derive(Clone)]
struct FieldState {
    value: SourceMetadataValue,
    revision: u64,
}

#[derive(Clone)]
struct ProjectedRecord {
    key: SourceEntityKey,
    parent: Option<SourceEntityKey>,
    parent_revision: u64,
    entity_revision: u64,
    fields: BTreeMap<u8, FieldState>,
}

#[derive(Clone)]
struct PendingUpsert {
    key: SourceEntityKey,
    parent: Option<SourceEntityKey>,
    fields: BTreeMap<u8, SourceMetadataValue>,
}

#[derive(Clone, Debug, Default)]
struct PaneFieldHints {
    title: Option<String>,
    current_path: Option<String>,
    current_command: Option<String>,
}

pub struct MetadataProjection {
    device_id: String,
    device_name: String,
    metadata_epoch: WireToken,
    server_epoch: Option<WireToken>,
    revision: u64,
    records: BTreeMap<RecordId, ProjectedRecord>,
    removed_at: BTreeMap<RecordId, u64>,
    pane_epochs: HashMap<String, WireToken>,
    unknown_pane_hints: HashMap<String, PaneFieldHints>,
    unknown_pane_order: VecDeque<String>,
    unknown_pane_bytes: usize,
    window_custom_names: HashMap<String, String>,
    pane_custom_names: HashMap<String, String>,
    dirty_upserts: BTreeMap<RecordId, PendingUpsert>,
    dirty_removals: BTreeMap<RecordId, SourceEntityKey>,
    dirty_removal_order: Vec<RecordId>,
    dirty_from_revision: Option<u64>,
    dirty_bytes: usize,
    established: bool,
    disposed: bool,
    pending_rebase: Option<MetadataProjectionSnapshot>,
    create_epoch: Box<dyn FnMut() -> WireToken + Send>,
}

impl MetadataProjection {
    pub fn new(device_id: impl Into<String>, device_name: Option<String>) -> Self {
        Self::with_epoch_factory(device_id, device_name, rand::random)
    }

    pub fn with_epoch_factory<Epoch>(
        device_id: impl Into<String>,
        device_name: Option<String>,
        mut create_epoch: Epoch,
    ) -> Self
    where
        Epoch: FnMut() -> WireToken + Send + 'static,
    {
        let device_id = device_id.into();
        let device_name = device_name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| device_id.clone());
        let metadata_epoch = create_epoch();
        Self {
            device_id,
            device_name,
            metadata_epoch,
            server_epoch: None,
            revision: 0,
            records: BTreeMap::new(),
            removed_at: BTreeMap::new(),
            pane_epochs: HashMap::new(),
            unknown_pane_hints: HashMap::new(),
            unknown_pane_order: VecDeque::new(),
            unknown_pane_bytes: 0,
            window_custom_names: HashMap::new(),
            pane_custom_names: HashMap::new(),
            dirty_upserts: BTreeMap::new(),
            dirty_removals: BTreeMap::new(),
            dirty_removal_order: Vec::new(),
            dirty_from_revision: None,
            dirty_bytes: 0,
            established: false,
            disposed: false,
            pending_rebase: None,
            create_epoch: Box::new(create_epoch),
        }
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn metadata_epoch(&self) -> WireToken {
        self.metadata_epoch
    }

    pub fn server_epoch(&self) -> Option<WireToken> {
        self.server_epoch
    }

    pub fn pane_epoch(&self, pane_id: &str) -> Option<WireToken> {
        self.pane_epochs.get(pane_id).copied()
    }

    pub fn ensure_pane_epoch(&mut self, pane_id: &str) -> Option<WireToken> {
        self.server_epoch?;
        Some(
            *self
                .pane_epochs
                .entry(pane_id.to_owned())
                .or_insert_with(|| (self.create_epoch)()),
        )
    }

    pub fn has_pane(&self, pane_id: &str) -> bool {
        self.records
            .contains_key(&(SOURCE_ENTITY_PANE, pane_id.to_owned()))
    }

    pub fn set_server_epoch(&mut self, server_epoch: WireToken) {
        if self.server_epoch == Some(server_epoch) {
            return;
        }
        let was_established = self.established;
        self.clear_pending();
        self.pending_rebase = None;
        self.records.clear();
        self.removed_at.clear();
        self.pane_epochs.clear();
        self.unknown_pane_hints.clear();
        self.unknown_pane_order.clear();
        self.unknown_pane_bytes = 0;
        self.server_epoch = Some(server_epoch);
        self.metadata_epoch = (self.create_epoch)();
        self.revision = 0;
        self.established = false;
        if was_established {
            self.pending_rebase = Some(self.current_snapshot());
        }
    }

    pub fn current_snapshot(&self) -> MetadataProjectionSnapshot {
        MetadataProjectionSnapshot {
            metadata_epoch: self.metadata_epoch,
            revision: self.revision,
            records: self.records.values().map(to_wire_record).collect(),
        }
    }

    pub fn take_rebase_required(&mut self) -> Option<MetadataProjectionSnapshot> {
        self.pending_rebase.take()
    }

    pub fn reconcile(
        &mut self,
        snapshot: &StateSnapshot,
        base_revision: Option<u64>,
    ) -> Result<(), MetadataProjectionError> {
        if self.disposed {
            return Ok(());
        }
        let Some(server_epoch) = self.server_epoch else {
            return Ok(());
        };
        let desired = self.build_desired(snapshot, server_epoch);
        if !self.established {
            self.records = desired
                .into_iter()
                .map(|(id, pending)| (id, create_record(pending, 1)))
                .collect();
            self.revision = 1;
            self.established = true;
            return Ok(());
        }

        let base_revision = base_revision.unwrap_or(self.revision);
        let next_revision = self
            .revision
            .checked_add(1)
            .ok_or(MetadataProjectionError::RevisionOverflow)?;
        let mut creates = Vec::new();
        let mut updates = Vec::new();
        for (id, wanted) in &desired {
            let Some(current) = self.records.get(id) else {
                if self.removed_at.get(id).copied().unwrap_or(0) <= base_revision {
                    creates.push((id.clone(), wanted.clone()));
                }
                continue;
            };
            let parent = (current.parent_revision <= base_revision
                && current.parent != wanted.parent)
                .then(|| wanted.parent.clone());
            let mut fields = Vec::new();
            let all_fields = current
                .fields
                .keys()
                .chain(wanted.fields.keys())
                .copied()
                .collect::<std::collections::BTreeSet<_>>();
            for field in all_fields {
                if field == SOURCE_FIELD_CUSTOM_NAME && !wanted.fields.contains_key(&field) {
                    continue;
                }
                let previous = current.fields.get(&field);
                if previous.is_some_and(|state| state.revision > base_revision) {
                    continue;
                }
                let next = wanted.fields.get(&field);
                if previous.map(|state| &state.value) != next {
                    fields.push((field, next.cloned()));
                }
            }
            if parent.is_some() || !fields.is_empty() {
                updates.push((id.clone(), parent, fields));
            }
        }
        let removals = self
            .records
            .iter()
            .filter(|(id, current)| {
                !desired.contains_key(*id) && current.entity_revision <= base_revision
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        if creates.is_empty() && updates.is_empty() && removals.is_empty() {
            return Ok(());
        }
        self.begin_dirty_revision();
        self.revision = next_revision;
        for (id, wanted) in creates {
            let created = create_record(wanted, next_revision);
            self.records.insert(id.clone(), created.clone());
            self.removed_at.remove(&id);
            self.mark_full_upsert(&created);
        }
        for (id, parent, fields) in updates {
            if let Some(parent) = parent {
                if let Some(record) = self.records.get_mut(&id) {
                    record.entity_revision = next_revision;
                    record.parent = parent;
                    record.parent_revision = next_revision;
                }
                self.mark_upsert_parent(&id);
            }
            for (field, value) in fields {
                self.set_record_field(&id, field, value, next_revision);
            }
        }
        for id in removals {
            if self.records.contains_key(&id) {
                self.remove_record(&id, next_revision);
            }
        }
        self.finish_mutation();
        Ok(())
    }

    pub fn apply_pane_title(
        &mut self,
        pane_id: &str,
        title: impl Into<String>,
    ) -> Result<(), MetadataProjectionError> {
        let title = title.into();
        if self.disposed || !self.established {
            self.remember_unknown_pane(
                pane_id,
                PaneFieldHints {
                    title: Some(title),
                    ..PaneFieldHints::default()
                },
            );
            return Ok(());
        }
        if !self.has_pane(pane_id) {
            self.remember_unknown_pane(
                pane_id,
                PaneFieldHints {
                    title: Some(title),
                    ..PaneFieldHints::default()
                },
            );
            return Ok(());
        }
        self.apply_field_changes(vec![(
            (SOURCE_ENTITY_PANE, pane_id.to_owned()),
            SOURCE_FIELD_TITLE,
            SourceMetadataValue::String(title),
        )])
    }

    pub fn apply_source_event(
        &mut self,
        event: &SourceMetadataEvent,
    ) -> Result<(), MetadataProjectionError> {
        if self.disposed || !self.established {
            match event {
                SourceMetadataEvent::PaneCurrentPath {
                    pane_id,
                    current_path,
                } => self.remember_unknown_pane(
                    pane_id,
                    PaneFieldHints {
                        current_path: Some(current_path.clone()),
                        ..PaneFieldHints::default()
                    },
                ),
                SourceMetadataEvent::PaneCurrentCommand {
                    pane_id,
                    current_command,
                } => self.remember_unknown_pane(
                    pane_id,
                    PaneFieldHints {
                        current_command: Some(current_command.clone()),
                        ..PaneFieldHints::default()
                    },
                ),
                _ => {}
            }
            return Ok(());
        }
        let mut changes = Vec::new();
        match event {
            SourceMetadataEvent::PaneCurrentPath {
                pane_id,
                current_path,
            } => {
                if self.has_pane(pane_id) {
                    changes.push((
                        (SOURCE_ENTITY_PANE, pane_id.clone()),
                        SOURCE_FIELD_CURRENT_PATH,
                        SourceMetadataValue::String(current_path.clone()),
                    ));
                } else {
                    self.remember_unknown_pane(
                        pane_id,
                        PaneFieldHints {
                            current_path: Some(current_path.clone()),
                            ..PaneFieldHints::default()
                        },
                    );
                }
            }
            SourceMetadataEvent::PaneCurrentCommand {
                pane_id,
                current_command,
            } => {
                if self.has_pane(pane_id) {
                    changes.push((
                        (SOURCE_ENTITY_PANE, pane_id.clone()),
                        SOURCE_FIELD_CURRENT_COMMAND,
                        SourceMetadataValue::String(current_command.clone()),
                    ));
                } else {
                    self.remember_unknown_pane(
                        pane_id,
                        PaneFieldHints {
                            current_command: Some(current_command.clone()),
                            ..PaneFieldHints::default()
                        },
                    );
                }
            }
            SourceMetadataEvent::SessionRenamed { session_id, name } => changes.push((
                (SOURCE_ENTITY_SESSION, session_id.clone()),
                SOURCE_FIELD_NAME,
                SourceMetadataValue::String(name.clone()),
            )),
            SourceMetadataEvent::WindowRenamed { window_id, name } => changes.push((
                (SOURCE_ENTITY_WINDOW, window_id.clone()),
                SOURCE_FIELD_NAME,
                SourceMetadataValue::String(name.clone()),
            )),
            SourceMetadataEvent::SessionWindowChanged {
                session_id,
                window_id,
            } => {
                self.apply_active_child(SOURCE_ENTITY_WINDOW, session_id, window_id)?;
                return Ok(());
            }
            SourceMetadataEvent::WindowPaneChanged { window_id, pane_id } => {
                self.apply_active_child(SOURCE_ENTITY_PANE, window_id, pane_id)?;
                return Ok(());
            }
            SourceMetadataEvent::LayoutChanged { window_id, layout } => {
                changes.push((
                    (SOURCE_ENTITY_WINDOW, window_id.clone()),
                    SOURCE_FIELD_LAYOUT,
                    SourceMetadataValue::String(layout.clone()),
                ));
                for leaf in parse_layout_leaves(layout) {
                    let pane_id = format!("%{}", leaf.pane_number);
                    changes.extend([
                        (
                            (SOURCE_ENTITY_PANE, pane_id.clone()),
                            SOURCE_FIELD_WIDTH,
                            SourceMetadataValue::U16(leaf.width),
                        ),
                        (
                            (SOURCE_ENTITY_PANE, pane_id.clone()),
                            SOURCE_FIELD_HEIGHT,
                            SourceMetadataValue::U16(leaf.height),
                        ),
                        (
                            (SOURCE_ENTITY_PANE, pane_id.clone()),
                            SOURCE_FIELD_LEFT,
                            SourceMetadataValue::U16(leaf.x),
                        ),
                        (
                            (SOURCE_ENTITY_PANE, pane_id),
                            SOURCE_FIELD_TOP,
                            SourceMetadataValue::U16(leaf.y),
                        ),
                    ]);
                }
            }
            SourceMetadataEvent::WindowClosed { window_id } => {
                let id = (SOURCE_ENTITY_WINDOW, window_id.clone());
                if !self.records.contains_key(&id) {
                    return Ok(());
                }
                let revision = self.next_revision()?;
                self.begin_dirty_revision();
                self.revision = revision;
                self.remove_record(&id, revision);
                self.finish_mutation();
                return Ok(());
            }
        }
        self.apply_field_changes(changes)
    }

    pub fn custom_name(&self, kind: ProjectionEntityKind, native_id: &str) -> Option<&str> {
        let names = match kind {
            ProjectionEntityKind::Window => &self.window_custom_names,
            ProjectionEntityKind::Pane => &self.pane_custom_names,
        };
        names.get(native_id).map(String::as_str)
    }

    pub fn set_custom_name(
        &mut self,
        kind: ProjectionEntityKind,
        native_id: &str,
        name: Option<String>,
    ) -> Result<(), MetadataProjectionError> {
        let name = name.filter(|name| !name.is_empty());
        let names = match kind {
            ProjectionEntityKind::Window => &mut self.window_custom_names,
            ProjectionEntityKind::Pane => &mut self.pane_custom_names,
        };
        if let Some(name) = &name {
            names.insert(native_id.to_owned(), name.clone());
        } else {
            names.remove(native_id);
        }
        let entity = match kind {
            ProjectionEntityKind::Window => SOURCE_ENTITY_WINDOW,
            ProjectionEntityKind::Pane => SOURCE_ENTITY_PANE,
        };
        let id = (entity, native_id.to_owned());
        if !self.records.contains_key(&id) {
            return Ok(());
        }
        let revision = self.next_revision()?;
        let value = name.map(SourceMetadataValue::String);
        if self
            .records
            .get(&id)
            .and_then(|record| record.fields.get(&SOURCE_FIELD_CUSTOM_NAME))
            .map(|field| &field.value)
            == value.as_ref()
        {
            return Ok(());
        }
        self.begin_dirty_revision();
        self.revision = revision;
        self.set_record_field(&id, SOURCE_FIELD_CUSTOM_NAME, value, revision);
        self.finish_mutation();
        Ok(())
    }

    pub fn flush_pending(
        &mut self,
    ) -> Result<Option<MetadataProjectionFlush>, MetadataProjectionError> {
        if let Some(rebase) = self.pending_rebase.take() {
            self.clear_pending();
            return Ok(Some(MetadataProjectionFlush::Rebase(rebase)));
        }
        let Some(from_revision) = self.dirty_from_revision else {
            return Ok(None);
        };
        let patch = SourceMetadataPatch {
            metadata_epoch: self.metadata_epoch,
            from_revision,
            through_revision: self.revision,
            upserts: self
                .dirty_upserts
                .values()
                .map(|upsert| SourceMetadataRecord {
                    key: upsert.key.clone(),
                    parent: upsert.parent.clone(),
                    fields: upsert
                        .fields
                        .iter()
                        .map(|(field, value)| SourceMetadataField {
                            field: *field,
                            value: value.clone(),
                        })
                        .collect(),
                })
                .collect(),
            removals: self
                .dirty_removal_order
                .iter()
                .filter_map(|id| self.dirty_removals.get(id).cloned())
                .collect(),
        };
        self.clear_pending();
        match encode_canonical_event(CanonicalEvent::SourceMetadataPatch(patch.clone())) {
            Ok(_) => Ok(Some(MetadataProjectionFlush::Patch(patch))),
            Err(ProtocolError::FrameTooLarge { .. }) => Ok(Some(MetadataProjectionFlush::Rebase(
                self.current_snapshot(),
            ))),
            Err(error) => Err(MetadataProjectionError::Protocol(error)),
        }
    }

    pub fn dispose(&mut self) {
        self.disposed = true;
        self.clear_pending();
        self.pending_rebase = None;
        self.records.clear();
        self.unknown_pane_hints.clear();
        self.unknown_pane_order.clear();
    }

    fn build_desired(
        &mut self,
        snapshot: &StateSnapshot,
        server_epoch: WireToken,
    ) -> BTreeMap<RecordId, PendingUpsert> {
        let mut desired = BTreeMap::new();
        let mut device = self.new_record(server_epoch, SOURCE_ENTITY_DEVICE, &self.device_id, None);
        device.fields.insert(
            SOURCE_FIELD_NAME,
            SourceMetadataValue::String(self.device_name.clone()),
        );
        device
            .fields
            .insert(SOURCE_FIELD_CONNECTED, SourceMetadataValue::Bool(true));
        desired.insert(record_id(&device.key), device.clone());

        let mut server = self.new_record(
            server_epoch,
            SOURCE_ENTITY_SERVER,
            SERVER_NATIVE_ID,
            Some(device.key.clone()),
        );
        server
            .fields
            .insert(SOURCE_FIELD_CONNECTED, SourceMetadataValue::Bool(true));
        desired.insert(record_id(&server.key), server.clone());
        let Some(session) = &snapshot.session else {
            return desired;
        };
        let mut session_record = self.new_record(
            server_epoch,
            SOURCE_ENTITY_SESSION,
            &session.id,
            Some(server.key),
        );
        session_record.fields.insert(
            SOURCE_FIELD_NAME,
            SourceMetadataValue::String(session.name.clone()),
        );
        desired.insert(record_id(&session_record.key), session_record.clone());
        for window in &session.windows {
            let mut window_record = self.new_record(
                server_epoch,
                SOURCE_ENTITY_WINDOW,
                &window.id,
                Some(session_record.key.clone()),
            );
            window_record.fields.insert(
                SOURCE_FIELD_NAME,
                SourceMetadataValue::String(window.name.clone()),
            );
            window_record.fields.insert(
                SOURCE_FIELD_INDEX,
                SourceMetadataValue::U32(u32::from(window.index)),
            );
            window_record.fields.insert(
                SOURCE_FIELD_ACTIVE,
                SourceMetadataValue::Bool(window.active),
            );
            if let Some(layout) = &window.layout {
                window_record.fields.insert(
                    SOURCE_FIELD_LAYOUT,
                    SourceMetadataValue::String(layout.clone()),
                );
            }
            if let Some(name) = self
                .window_custom_names
                .get(&window.id)
                .cloned()
                .or(window.custom_name.clone())
            {
                window_record
                    .fields
                    .insert(SOURCE_FIELD_CUSTOM_NAME, SourceMetadataValue::String(name));
            }
            desired.insert(record_id(&window_record.key), window_record.clone());
            for pane in &window.panes {
                let mut pane_record = self.new_record(
                    server_epoch,
                    SOURCE_ENTITY_PANE,
                    &pane.id,
                    Some(window_record.key.clone()),
                );
                pane_record.fields.insert(
                    SOURCE_FIELD_INDEX,
                    SourceMetadataValue::U32(u32::from(pane.index)),
                );
                pane_record
                    .fields
                    .insert(SOURCE_FIELD_ACTIVE, SourceMetadataValue::Bool(pane.active));
                pane_record
                    .fields
                    .insert(SOURCE_FIELD_WIDTH, SourceMetadataValue::U16(pane.width));
                pane_record
                    .fields
                    .insert(SOURCE_FIELD_HEIGHT, SourceMetadataValue::U16(pane.height));
                if let Some(left) = pane.left {
                    pane_record
                        .fields
                        .insert(SOURCE_FIELD_LEFT, SourceMetadataValue::U16(left));
                }
                if let Some(top) = pane.top {
                    pane_record
                        .fields
                        .insert(SOURCE_FIELD_TOP, SourceMetadataValue::U16(top));
                }
                if let Some(title) = &pane.title {
                    pane_record.fields.insert(
                        SOURCE_FIELD_TITLE,
                        SourceMetadataValue::String(title.clone()),
                    );
                }
                if let Some(path) = &pane.current_path {
                    pane_record.fields.insert(
                        SOURCE_FIELD_CURRENT_PATH,
                        SourceMetadataValue::String(path.clone()),
                    );
                }
                if let Some(command) = &pane.current_command {
                    pane_record.fields.insert(
                        SOURCE_FIELD_CURRENT_COMMAND,
                        SourceMetadataValue::String(command.clone()),
                    );
                }
                let pane_epoch = *self
                    .pane_epochs
                    .entry(pane.id.clone())
                    .or_insert_with(|| (self.create_epoch)());
                pane_record.fields.insert(
                    SOURCE_FIELD_PANE_EPOCH,
                    SourceMetadataValue::Bytes16(pane_epoch),
                );
                if let Some(name) = self
                    .pane_custom_names
                    .get(&pane.id)
                    .cloned()
                    .or(pane.custom_name.clone())
                {
                    pane_record
                        .fields
                        .insert(SOURCE_FIELD_CUSTOM_NAME, SourceMetadataValue::String(name));
                }
                if let Some(hints) = self.unknown_pane_hints.remove(&pane.id) {
                    self.unknown_pane_order.retain(|id| id != &pane.id);
                    if let Some(title) = hints.title {
                        pane_record
                            .fields
                            .insert(SOURCE_FIELD_TITLE, SourceMetadataValue::String(title));
                    }
                    if let Some(path) = hints.current_path {
                        pane_record
                            .fields
                            .insert(SOURCE_FIELD_CURRENT_PATH, SourceMetadataValue::String(path));
                    }
                    if let Some(command) = hints.current_command {
                        pane_record.fields.insert(
                            SOURCE_FIELD_CURRENT_COMMAND,
                            SourceMetadataValue::String(command),
                        );
                    }
                    self.recalculate_unknown_pane_bytes();
                }
                desired.insert(record_id(&pane_record.key), pane_record);
            }
        }
        desired
    }

    fn new_record(
        &self,
        server_epoch: WireToken,
        entity_kind: u8,
        native_id: &str,
        parent: Option<SourceEntityKey>,
    ) -> PendingUpsert {
        PendingUpsert {
            key: SourceEntityKey {
                device_id: self.device_id.clone(),
                server_epoch,
                entity_kind,
                native_id: native_id.to_owned(),
            },
            parent,
            fields: BTreeMap::new(),
        }
    }

    fn apply_field_changes(
        &mut self,
        changes: Vec<(RecordId, u8, SourceMetadataValue)>,
    ) -> Result<(), MetadataProjectionError> {
        let changes = changes
            .into_iter()
            .filter(|(id, field, value)| {
                self.records.get(id).is_some_and(|record| {
                    record.fields.get(field).map(|state| &state.value) != Some(value)
                })
            })
            .collect::<Vec<_>>();
        if changes.is_empty() {
            return Ok(());
        }
        let revision = self.next_revision()?;
        self.begin_dirty_revision();
        self.revision = revision;
        for (id, field, value) in changes {
            self.set_record_field(&id, field, Some(value), revision);
        }
        self.finish_mutation();
        Ok(())
    }

    fn apply_active_child(
        &mut self,
        child_kind: u8,
        parent_native_id: &str,
        active_native_id: &str,
    ) -> Result<(), MetadataProjectionError> {
        let changes = self
            .records
            .iter()
            .filter(|(_, record)| {
                record.key.entity_kind == child_kind
                    && record.parent.as_ref().is_some_and(|parent| {
                        parent.entity_kind + 1 == child_kind && parent.native_id == parent_native_id
                    })
            })
            .map(|(id, record)| {
                (
                    id.clone(),
                    SOURCE_FIELD_ACTIVE,
                    SourceMetadataValue::Bool(record.key.native_id == active_native_id),
                )
            })
            .collect();
        self.apply_field_changes(changes)
    }

    fn next_revision(&self) -> Result<u64, MetadataProjectionError> {
        self.revision
            .checked_add(1)
            .ok_or(MetadataProjectionError::RevisionOverflow)
    }
    fn begin_dirty_revision(&mut self) {
        if self.dirty_from_revision.is_none() {
            self.dirty_from_revision = Some(self.revision);
        }
    }

    fn set_record_field(
        &mut self,
        id: &RecordId,
        field: u8,
        value: Option<SourceMetadataValue>,
        revision: u64,
    ) {
        let (key, parent) = {
            let Some(record) = self.records.get_mut(id) else {
                return;
            };
            record.entity_revision = revision;
            if let Some(value) = &value {
                record.fields.insert(
                    field,
                    FieldState {
                        value: value.clone(),
                        revision,
                    },
                );
            } else {
                record.fields.remove(&field);
            }
            (record.key.clone(), record.parent.clone())
        };
        let upsert = self
            .dirty_upserts
            .entry(id.clone())
            .or_insert_with(|| PendingUpsert {
                key,
                parent: parent.clone(),
                fields: BTreeMap::new(),
            });
        upsert.parent = parent;
        upsert
            .fields
            .insert(field, value.unwrap_or(SourceMetadataValue::Unset));
        self.dirty_removals.remove(id);
        self.dirty_removal_order.retain(|candidate| candidate != id);
        self.recalculate_dirty_bytes();
    }

    fn mark_upsert_parent(&mut self, id: &RecordId) {
        let Some(record) = self.records.get(id) else {
            return;
        };
        self.dirty_upserts
            .entry(id.clone())
            .or_insert_with(|| PendingUpsert {
                key: record.key.clone(),
                parent: record.parent.clone(),
                fields: BTreeMap::new(),
            })
            .parent = record.parent.clone();
        self.dirty_removals.remove(id);
        self.dirty_removal_order.retain(|candidate| candidate != id);
        self.recalculate_dirty_bytes();
    }

    fn mark_full_upsert(&mut self, record: &ProjectedRecord) {
        let id = record_id(&record.key);
        self.dirty_removals.remove(&id);
        self.dirty_removal_order
            .retain(|candidate| candidate != &id);
        self.dirty_upserts.insert(
            id,
            PendingUpsert {
                key: record.key.clone(),
                parent: record.parent.clone(),
                fields: record
                    .fields
                    .iter()
                    .map(|(field, state)| (*field, state.value.clone()))
                    .collect(),
            },
        );
        self.recalculate_dirty_bytes();
    }

    fn remove_record(&mut self, id: &RecordId, revision: u64) {
        let Some(record) = self.records.get(id).cloned() else {
            return;
        };
        let children = self
            .records
            .iter()
            .filter(|(_, candidate)| candidate.parent.as_ref() == Some(&record.key))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for child in children {
            self.remove_record(&child, revision);
        }
        self.records.remove(id);
        self.removed_at.insert(id.clone(), revision);
        if record.key.entity_kind == SOURCE_ENTITY_PANE {
            self.pane_epochs.remove(&record.key.native_id);
        }
        self.dirty_upserts.remove(id);
        if !self.dirty_removals.contains_key(id) {
            self.dirty_removal_order.push(id.clone());
        }
        self.dirty_removals.insert(id.clone(), record.key);
        self.recalculate_dirty_bytes();
    }

    fn finish_mutation(&mut self) {
        if self.dirty_bytes > MAX_PENDING_METADATA_BYTES {
            self.clear_pending();
            self.pending_rebase = Some(self.current_snapshot());
        }
    }

    fn remember_unknown_pane(&mut self, pane_id: &str, fields: PaneFieldHints) {
        if !self.unknown_pane_hints.contains_key(pane_id)
            && self.unknown_pane_hints.len() >= MAX_UNKNOWN_PANES
        {
            self.remove_oldest_unknown_pane();
        }
        if !self.unknown_pane_hints.contains_key(pane_id) {
            self.unknown_pane_order.push_back(pane_id.to_owned());
        }
        let hints = self
            .unknown_pane_hints
            .entry(pane_id.to_owned())
            .or_default();
        if fields.title.is_some() {
            hints.title = fields.title;
        }
        if fields.current_path.is_some() {
            hints.current_path = fields.current_path;
        }
        if fields.current_command.is_some() {
            hints.current_command = fields.current_command;
        }
        self.recalculate_unknown_pane_bytes();
        while self.unknown_pane_bytes > MAX_UNKNOWN_PANE_BYTES {
            self.remove_oldest_unknown_pane();
        }
    }

    fn remove_oldest_unknown_pane(&mut self) {
        if let Some(pane_id) = self.unknown_pane_order.pop_front() {
            self.unknown_pane_hints.remove(&pane_id);
            self.recalculate_unknown_pane_bytes();
        }
    }
    fn recalculate_unknown_pane_bytes(&mut self) {
        self.unknown_pane_bytes = self
            .unknown_pane_hints
            .iter()
            .map(|(pane_id, fields)| {
                (pane_id.len()
                    + fields.title.as_ref().map_or(0, String::len)
                    + fields.current_path.as_ref().map_or(0, String::len)
                    + fields.current_command.as_ref().map_or(0, String::len))
                    * 3
            })
            .sum();
    }
    fn recalculate_dirty_bytes(&mut self) {
        self.dirty_bytes = self
            .dirty_upserts
            .values()
            .map(estimate_upsert_bytes)
            .sum::<usize>()
            + self
                .dirty_removals
                .values()
                .map(estimate_key_bytes)
                .sum::<usize>();
    }
    fn clear_pending(&mut self) {
        self.dirty_upserts.clear();
        self.dirty_removals.clear();
        self.dirty_removal_order.clear();
        self.dirty_from_revision = None;
        self.dirty_bytes = 0;
    }
}

fn create_record(source: PendingUpsert, revision: u64) -> ProjectedRecord {
    ProjectedRecord {
        key: source.key,
        parent: source.parent,
        parent_revision: revision,
        entity_revision: revision,
        fields: source
            .fields
            .into_iter()
            .map(|(field, value)| (field, FieldState { value, revision }))
            .collect(),
    }
}
fn to_wire_record(record: &ProjectedRecord) -> SourceMetadataRecord {
    SourceMetadataRecord {
        key: record.key.clone(),
        parent: record.parent.clone(),
        fields: record
            .fields
            .iter()
            .map(|(field, state)| SourceMetadataField {
                field: *field,
                value: state.value.clone(),
            })
            .collect(),
    }
}
fn record_id(key: &SourceEntityKey) -> RecordId {
    (key.entity_kind, key.native_id.clone())
}
fn estimate_key_bytes(key: &SourceEntityKey) -> usize {
    32 + key.device_id.len() * 3 + key.native_id.len() * 3
}
fn estimate_upsert_bytes(upsert: &PendingUpsert) -> usize {
    estimate_key_bytes(&upsert.key)
        + upsert.parent.as_ref().map_or(1, estimate_key_bytes)
        + upsert
            .fields
            .values()
            .map(|value| {
                8 + match value {
                    SourceMetadataValue::String(value) => value.len() * 3,
                    SourceMetadataValue::Bytes16(_) => 16,
                    _ => 0,
                }
            })
            .sum::<usize>()
}

#[derive(Clone, Copy)]
struct LayoutLeaf {
    pane_number: u32,
    width: u16,
    height: u16,
    x: u16,
    y: u16,
}
struct LayoutParser<'a> {
    input: &'a [u8],
    position: usize,
}
fn parse_layout_leaves(layout: &str) -> Vec<LayoutLeaf> {
    let bytes = layout.as_bytes();
    if bytes.len() < 6 || !bytes[..4].iter().all(u8::is_ascii_hexdigit) || bytes[4] != b',' {
        return Vec::new();
    }
    let mut parser = LayoutParser {
        input: bytes,
        position: 5,
    };
    let Some(leaves) = parser.node() else {
        return Vec::new();
    };
    if parser.position == bytes.len() {
        leaves
    } else {
        Vec::new()
    }
}
impl LayoutParser<'_> {
    fn number(&mut self) -> Option<u32> {
        let start = self.position;
        while self
            .input
            .get(self.position)
            .is_some_and(u8::is_ascii_digit)
        {
            self.position += 1;
        }
        (self.position > start)
            .then(|| {
                std::str::from_utf8(&self.input[start..self.position])
                    .ok()?
                    .parse()
                    .ok()
            })
            .flatten()
    }
    fn consume(&mut self, byte: u8) -> bool {
        if self.input.get(self.position) == Some(&byte) {
            self.position += 1;
            true
        } else {
            false
        }
    }
    fn node(&mut self) -> Option<Vec<LayoutLeaf>> {
        let width = u16::try_from(self.number()?).ok()?;
        if !self.consume(b'x') {
            return None;
        }
        let height = u16::try_from(self.number()?).ok()?;
        if !self.consume(b',') {
            return None;
        }
        let x = u16::try_from(self.number()?).ok()?;
        if !self.consume(b',') {
            return None;
        }
        let y = u16::try_from(self.number()?).ok()?;
        if self.consume(b',') {
            return Some(vec![LayoutLeaf {
                pane_number: self.number()?,
                width,
                height,
                x,
                y,
            }]);
        }
        let opener = *self.input.get(self.position)?;
        let closer = match opener {
            b'{' => b'}',
            b'[' => b']',
            _ => return None,
        };
        self.position += 1;
        let mut leaves = Vec::new();
        let mut children = 0;
        loop {
            leaves.extend(self.node()?);
            children += 1;
            if self.consume(b',') {
                continue;
            }
            if self.consume(closer) {
                break;
            }
            return None;
        }
        (children >= 2).then_some(leaves)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(title: &str) -> StateSnapshot {
        StateSnapshot {
            device_id: "device-a".to_owned(),
            session: Some(tmex_protocol::SessionWire {
                id: "$1".to_owned(),
                name: "work".to_owned(),
                windows: vec![tmex_protocol::WindowWire {
                    id: "@1".to_owned(),
                    name: "main".to_owned(),
                    custom_name: None,
                    index: 0,
                    active: true,
                    layout: Some("b25d,80x24,0,0,1".to_owned()),
                    panes: vec![tmex_protocol::PaneWire {
                        id: "%1".to_owned(),
                        window_id: "@1".to_owned(),
                        index: 0,
                        title: Some(title.to_owned()),
                        custom_name: None,
                        active: true,
                        width: 80,
                        height: 24,
                        current_path: Some("/work".to_owned()),
                        current_command: Some("zsh".to_owned()),
                        left: Some(0),
                        top: Some(0),
                    }],
                }],
            }),
        }
    }

    #[test]
    fn stale_reconcile_cannot_overwrite_newer_output_metadata() {
        let mut next = 10_u8;
        let mut projection = MetadataProjection::with_epoch_factory(
            "device-a",
            Some("Developer Mac".to_owned()),
            move || {
                let epoch = [next; 16];
                next += 1;
                epoch
            },
        );
        projection.set_server_epoch([0; 16]);
        projection.reconcile(&snapshot("old"), None).unwrap();
        let base = projection.revision();
        projection.apply_pane_title("%1", "new").unwrap();
        projection.reconcile(&snapshot("old"), Some(base)).unwrap();
        let pane = projection
            .current_snapshot()
            .records
            .into_iter()
            .find(|record| record.key.entity_kind == SOURCE_ENTITY_PANE)
            .unwrap();
        assert!(pane
            .fields
            .iter()
            .any(|field| field.field == SOURCE_FIELD_TITLE
                && field.value == SourceMetadataValue::String("new".to_owned())));
    }
}
