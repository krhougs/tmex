import { ShortcutButtonRow } from '@/components/settings/ShortcutButtonRow';
import {
  fetchTerminalShortcuts,
  terminalShortcutsQueryKey,
  updateTerminalShortcuts,
} from '@/components/settings/terminal-shortcuts-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  escapeForDisplay,
  keyEventToTerminalSequence,
  parseEscapeSequence,
} from '@/utils/terminalKeySequence';
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_TERMINAL_SHORTCUTS,
  type TerminalShortcutAction,
  type TerminalShortcutItem,
} from '@tmex/shared';
import {
  ArrowDownToLine,
  ClipboardPaste,
  GripVertical,
  Keyboard,
  type LucideIcon,
  Plus,
  Radar,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

const ACTION_META: { action: TerminalShortcutAction; icon: LucideIcon }[] = [
  { action: 'paste', icon: ClipboardPaste },
  { action: 'toggleKeyboard', icon: Keyboard },
  { action: 'newAgentSession', icon: Radar },
  { action: 'scrollToBottom', icon: ArrowDownToLine },
];

function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sc-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

// 按固定字段顺序归一化后比较，规避对象键顺序差异（服务端规范化 vs 前端构造）造成的假阳性。
function normItem(i: TerminalShortcutItem): string {
  return JSON.stringify([i.id, i.type, i.label, i.payload ?? null, i.action ?? null]);
}
function sameItems(a: TerminalShortcutItem[], b: TerminalShortcutItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((it, idx) => normItem(it) === normItem(b[idx]));
}

function ActionBadge({ action }: { action: TerminalShortcutAction }) {
  const { t } = useTranslation();
  const Icon = ACTION_META.find((m) => m.action === action)?.icon ?? Radar;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
      <Icon className="h-3.5 w-3.5" />
      {t(`settings.terminal.shortcuts.action.${action}`)}
    </span>
  );
}

function SortableShortcutRow({
  item,
  onLabelChange,
  onPayloadChange,
  onRemove,
}: {
  item: TerminalShortcutItem;
  onLabelChange: (id: string, label: string) => void;
  onPayloadChange: (id: string, payload: string) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });
  const isAction = item.type === 'action';

  // payload 行内编辑用本地草稿（展示转义串），失焦时解析回原始序列，避免每次输入抖动
  const [payloadDraft, setPayloadDraft] = useState(() => escapeForDisplay(item.payload ?? ''));
  useEffect(() => {
    setPayloadDraft(escapeForDisplay(item.payload ?? ''));
  }, [item.payload]);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'flex items-center gap-2 rounded-lg border border-border bg-background p-2.5',
        isDragging && 'opacity-60 shadow-sm'
      )}
      data-testid={`shortcut-editor-row-${item.id}`}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={t('settings.terminal.shortcuts.dragHandle')}
        className="shrink-0 cursor-grab touch-none text-muted-foreground hover:text-foreground"
      >
        <GripVertical className="h-4 w-4" />
      </button>

      {isAction && item.action ? (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ActionBadge action={item.action} />
          <Input
            value={item.label}
            onChange={(e) => onLabelChange(item.id, e.target.value)}
            placeholder={t(`settings.terminal.shortcuts.action.${item.action}`)}
            className="h-9 min-w-0 flex-1"
            data-testid={`shortcut-editor-label-${item.id}`}
          />
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Input
            value={item.label}
            onChange={(e) => onLabelChange(item.id, e.target.value)}
            placeholder={t('settings.terminal.shortcuts.labelPlaceholder')}
            className="h-9 w-24 font-mono"
            data-testid={`shortcut-editor-label-${item.id}`}
          />
          <Input
            value={payloadDraft}
            onChange={(e) => setPayloadDraft(e.target.value)}
            onBlur={() => onPayloadChange(item.id, parseEscapeSequence(payloadDraft))}
            placeholder={t('settings.terminal.shortcuts.payloadPlaceholder')}
            spellCheck={false}
            className="h-9 min-w-0 flex-1 font-mono text-xs"
            data-testid={`shortcut-editor-payload-${item.id}`}
          />
        </div>
      )}

      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => onRemove(item.id)}
        aria-label={t('settings.terminal.shortcuts.delete')}
        data-testid={`shortcut-editor-remove-${item.id}`}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

/**
 * 终端快捷键编辑器：草稿态编辑 + 拖拽排序 + 三入口录入 + 图标开关 + 实时预览，
 * 显式「保存」写入服务器（保存后经 react-query 失效让终端栏即时刷新）。
 */
export function TerminalShortcutsEditor() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: terminalShortcutsQueryKey,
    queryFn: fetchTerminalShortcuts,
  });

  const [items, setItems] = useState<TerminalShortcutItem[]>([]);
  const [useIcons, setUseIcons] = useState(false);
  // 与服务器对齐的基线快照（null=未初始化）；dirty 与外部更新跟随都基于它
  const [baseline, setBaseline] = useState<{
    items: TerminalShortcutItem[];
    useIcons: boolean;
  } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [manualLabel, setManualLabel] = useState('');
  const [manualPayload, setManualPayload] = useState('');

  // 初始化，以及当用户未编辑时跟随服务器最新值（其它端保存触发的后台 refetch），
  // 既消除假 dirty、也避免用陈旧草稿盲覆盖他端更新。
  // 注意：用户正在编辑（dirty）时发生的并发更新仍可能在保存时覆盖他端，完整解决需乐观并发锁。
  useEffect(() => {
    if (!data) return;
    if (baseline === null) {
      setItems(data.items);
      setUseIcons(data.useIcons);
      setBaseline({ items: data.items, useIcons: data.useIcons });
      return;
    }
    if (sameItems(baseline.items, data.items) && baseline.useIcons === data.useIcons) {
      return; // baseline 已与服务器一致，无需动作（避免循环）
    }
    const pristine = sameItems(items, baseline.items) && useIcons === baseline.useIcons;
    if (pristine) {
      setItems(data.items);
      setUseIcons(data.useIcons);
      setBaseline({ items: data.items, useIcons: data.useIcons });
    }
  }, [data, baseline, items, useIcons]);

  const dirty = useMemo(() => {
    if (!baseline) return false;
    return !sameItems(items, baseline.items) || useIcons !== baseline.useIcons;
  }, [items, useIcons, baseline]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const mutation = useMutation({
    mutationFn: () => updateTerminalShortcuts({ items, useIcons }),
    onSuccess: (saved) => {
      queryClient.setQueryData(terminalShortcutsQueryKey, saved);
      setItems(saved.items);
      setUseIcons(saved.useIcons);
      setBaseline({ items: saved.items, useIcons: saved.useIcons });
      toast.success(t('settings.terminal.shortcuts.saved'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('settings.terminal.shortcuts.saveFailed'));
    },
  });

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setItems((prev) => {
      const oldIndex = prev.findIndex((i) => i.id === active.id);
      const newIndex = prev.findIndex((i) => i.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  };

  const updateLabel = (id: string, label: string) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, label } : i)));
  const updatePayload = (id: string, payload: string) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, payload } : i)));
  const removeItem = (id: string) => setItems((prev) => prev.filter((i) => i.id !== id));

  const addSend = (label: string, payload: string) => {
    if (!payload) return;
    setItems((prev) => [...prev, { id: genId(), type: 'send', label: label || payload, payload }]);
  };
  const addAction = (action: TerminalShortcutAction) =>
    setItems((prev) => [...prev, { id: genId(), type: 'action', action, label: '' }]);

  const handleReset = () => {
    setItems(DEFAULT_TERMINAL_SHORTCUTS.map((i) => ({ ...i })));
    setUseIcons(false);
  };

  const onCaptureKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const seq = keyEventToTerminalSequence({
      key: e.key,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
    });
    if (seq) {
      addSend(seq.label, seq.payload);
      setCapturing(false);
    }
  };

  const addManual = () => {
    const payload = parseEscapeSequence(manualPayload);
    if (!payload) return;
    addSend(manualLabel.trim(), payload);
    setManualLabel('');
    setManualPayload('');
  };

  if (isError && !baseline) {
    return (
      <div className="space-y-2" data-testid="terminal-shortcuts-error">
        <p className="text-destructive text-sm">{t('settings.terminal.shortcuts.loadFailed')}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => refetch()}>
          {t('settings.terminal.shortcuts.retry')}
        </Button>
      </div>
    );
  }
  if (isLoading && !baseline) {
    return (
      <p className="text-muted-foreground text-sm">{t('settings.terminal.shortcuts.loading')}</p>
    );
  }

  return (
    <div className="space-y-5" data-testid="terminal-shortcuts-editor">
      {/* 实时预览 */}
      <div className="space-y-2">
        <span className="block font-medium text-sm">
          {t('settings.terminal.shortcuts.preview')}
        </span>
        <div
          className="rounded-lg border border-border bg-muted/30 px-3"
          data-testid="shortcut-preview"
        >
          <ShortcutButtonRow items={items} useIcons={useIcons} />
        </div>
      </div>

      {/* 图标开关（对齐设置项行：边框盒子 + 左标签右开关） */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-sm">{t('settings.terminal.shortcuts.useIcons')}</span>
          <span className="text-muted-foreground text-xs">
            {t('settings.terminal.shortcuts.useIconsDesc')}
          </span>
        </span>
        <Switch
          checked={useIcons}
          onCheckedChange={(checked) => setUseIcons(checked)}
          aria-label={t('settings.terminal.shortcuts.useIcons')}
          data-testid="shortcut-use-icons"
        />
      </div>

      {/* 可拖拽列表 */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-2" data-testid="shortcut-editor-list">
            {items.map((item) => (
              <SortableShortcutRow
                key={item.id}
                item={item}
                onLabelChange={updateLabel}
                onPayloadChange={updatePayload}
                onRemove={removeItem}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* 添加区 */}
      <div className="space-y-3 rounded-lg border border-dashed border-border p-4">
        <span className="block font-medium text-sm">
          {t('settings.terminal.shortcuts.addShortcut')}
        </span>

        {/* 按键捕获 */}
        <button
          type="button"
          onKeyDown={onCaptureKeyDown}
          onFocus={() => setCapturing(true)}
          onBlur={() => setCapturing(false)}
          className={cn(
            'w-full rounded-lg border px-3 py-2.5 text-center text-sm outline-none transition-colors',
            capturing
              ? 'border-primary bg-primary/5 text-foreground'
              : 'border-border text-muted-foreground'
          )}
          data-testid="shortcut-capture-input"
        >
          {capturing
            ? t('settings.terminal.shortcuts.capturePrompt')
            : t('settings.terminal.shortcuts.captureHint')}
        </button>

        {/* 特殊动作 */}
        <div className="flex flex-wrap gap-1.5">
          {ACTION_META.map(({ action, icon: Icon }) => (
            <Button
              key={action}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => addAction(action)}
              data-testid={`shortcut-add-action-${action}`}
            >
              <Icon className="h-3.5 w-3.5" />
              {t(`settings.terminal.shortcuts.action.${action}`)}
            </Button>
          ))}
        </div>

        {/* 高级手填 */}
        <button
          type="button"
          className="text-muted-foreground text-xs underline underline-offset-2"
          onClick={() => setAdvancedOpen((o) => !o)}
        >
          {t('settings.terminal.shortcuts.advanced')}
        </button>
        {advancedOpen && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              value={manualLabel}
              onChange={(e) => setManualLabel(e.target.value)}
              placeholder={t('settings.terminal.shortcuts.labelPlaceholder')}
              className="h-9 w-24 font-mono"
              data-testid="shortcut-manual-label"
            />
            <Input
              value={manualPayload}
              onChange={(e) => setManualPayload(e.target.value)}
              placeholder={t('settings.terminal.shortcuts.payloadPlaceholder')}
              spellCheck={false}
              className="h-9 min-w-0 flex-1 font-mono text-xs"
              data-testid="shortcut-manual-payload"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addManual}
              data-testid="shortcut-manual-add"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('settings.terminal.shortcuts.add')}
            </Button>
          </div>
        )}
      </div>

      {/* 保存 / 重置 */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleReset}
          data-testid="shortcut-reset"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t('settings.terminal.shortcuts.reset')}
        </Button>
        <Button
          type="button"
          variant="default"
          size="default"
          onClick={() => mutation.mutate()}
          disabled={!dirty || mutation.isPending}
          data-testid="shortcut-save"
        >
          {t('settings.terminal.shortcuts.save')}
        </Button>
      </div>
    </div>
  );
}
