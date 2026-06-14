import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// 文件树展开状态，按 (rootId, path) 复合键记录（不同设备/根下路径可能同名）。
// 持久化到 localStorage，刷新后恢复展开（req3）；陈旧键（根/设备已不存在）在加载时由 UI 剪枝。
export function fileNodeKey(rootId: string, path: string): string {
  return `${rootId}\n${path}`;
}

interface FileTreeState {
  expanded: Record<string, boolean>;
  toggle: (rootId: string, path: string) => void;
  expand: (rootId: string, path: string) => void;
  collapse: (rootId: string, path: string) => void;
  /** 移除某 root 下的全部展开态（root 被删/禁用/设备消失时调用） */
  pruneRoot: (rootId: string) => void;
  /** 仅保留 rootId 属于 validRootIds 的展开键（加载时清理陈旧持久化） */
  pruneStaleRoots: (validRootIds: string[]) => void;
}

export const useFileTreeStore = create<FileTreeState>()(
  persist(
    (set) => ({
      expanded: {},
      toggle: (rootId, path) =>
        set((s) => {
          const k = fileNodeKey(rootId, path);
          const next = { ...s.expanded };
          if (next[k]) delete next[k];
          else next[k] = true;
          return { expanded: next };
        }),
      expand: (rootId, path) =>
        set((s) => {
          const k = fileNodeKey(rootId, path);
          return s.expanded[k] ? s : { expanded: { ...s.expanded, [k]: true } };
        }),
      collapse: (rootId, path) =>
        set((s) => {
          const k = fileNodeKey(rootId, path);
          if (!s.expanded[k]) return s;
          const next = { ...s.expanded };
          delete next[k];
          return { expanded: next };
        }),
      pruneRoot: (rootId) =>
        set((s) => {
          const prefix = `${rootId}\n`;
          const next: Record<string, boolean> = {};
          for (const k of Object.keys(s.expanded)) {
            if (!k.startsWith(prefix)) next[k] = s.expanded[k];
          }
          return { expanded: next };
        }),
      pruneStaleRoots: (validRootIds) =>
        set((s) => {
          const valid = new Set(validRootIds);
          const next: Record<string, boolean> = {};
          let changed = false;
          for (const k of Object.keys(s.expanded)) {
            const rootId = k.slice(0, k.indexOf('\n'));
            if (valid.has(rootId)) next[k] = s.expanded[k];
            else changed = true;
          }
          return changed ? { expanded: next } : s;
        }),
    }),
    { name: 'tmex-file-tree', partialize: (s) => ({ expanded: s.expanded }) }
  )
);
