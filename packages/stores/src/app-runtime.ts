// createAppRuntime：按依赖顺序组装各 store，产出可整体销毁的应用运行时。
// 默认 runtime 在 index.ts 构造（首次 import 即建，与既有模块级单例时序等价）。

import { createAgentStore } from './agent';
import { createFileTreeStore } from './file-tree';
import { type AppRuntimeOptions, type RuntimeCore, resolveRuntimeCore } from './runtime';
import { createSiteStore } from './site';
import { createTmuxStore } from './tmux';
import { createUIStore } from './ui';

export interface AppRuntime extends RuntimeCore {
  stores: {
    ui: ReturnType<typeof createUIStore>;
    site: ReturnType<typeof createSiteStore>;
    tmux: ReturnType<typeof createTmuxStore>;
    agent: ReturnType<typeof createAgentStore>;
    fileTree: ReturnType<typeof createFileTreeStore>;
  };
  /** 注销全部 WS handler 与订阅（多实例宿主卸载实例时调用） */
  dispose(): void;
}

export function createAppRuntime(options: AppRuntimeOptions = {}): AppRuntime {
  const core = resolveRuntimeCore(options);
  const disposers: Array<() => void> = [];

  const ui = options.uiStore ?? createUIStore(core);
  const site = createSiteStore(core, () => ui);
  const tmux = createTmuxStore(
    core,
    {
      getUI: () => ui,
      getSite: () => site,
      createWindowTimeoutMs: options.createWindowTimeoutMs,
    },
    disposers
  );
  const agent = createAgentStore(core, disposers);
  const fileTree = createFileTreeStore(core);

  return {
    ...core,
    stores: { ui, site, tmux, agent, fileTree },
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          // 注销回调不抛出
        }
      }
    },
  };
}
