import { DEFAULT_FONT_ID } from '@/lib/fonts/manifest.generated';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SidebarTab = 'panes' | 'agent' | 'files';

// 终端字体设置默认值（与 ghostty-terminal 内置默认保持一致）。
const DEFAULT_TERMINAL_FONT_SIZE = 13;
const DEFAULT_TERMINAL_LINE_HEIGHT = 1.2;

interface UIState {
  sidebarCollapsed: boolean;
  sidebarTab: SidebarTab;
  inputMode: 'direct' | 'editor';
  editorSendWithEnter: boolean;
  theme: 'light' | 'dark';
  editorHistory: string[];
  editorDrafts: Record<string, string>;
  // 终端字体（每设备本地持久化）：字号/行高仅作用于终端，字体族经 --font-mono 全应用统一。
  terminalFontSize: number;
  terminalLineHeight: number;
  terminalFontId: string;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setInputMode: (mode: 'direct' | 'editor') => void;
  setEditorSendWithEnter: (enabled: boolean) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  addEditorHistory: (text: string) => void;
  setEditorDraft: (draftKey: string, text: string) => void;
  removeEditorDraft: (draftKey: string) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalLineHeight: (height: number) => void;
  setTerminalFontId: (fontId: string) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      sidebarTab: 'panes',
      inputMode: 'direct',
      editorSendWithEnter: true,
      theme: 'dark',
      editorHistory: [],
      editorDrafts: {},
      terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
      terminalLineHeight: DEFAULT_TERMINAL_LINE_HEIGHT,
      terminalFontId: DEFAULT_FONT_ID,

      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setSidebarTab: (tab) => set({ sidebarTab: tab }),
      setInputMode: (mode) => set({ inputMode: mode }),
      setEditorSendWithEnter: (enabled) => set({ editorSendWithEnter: enabled }),
      setTheme: (theme) => set({ theme }),
      setTerminalFontSize: (size) => set({ terminalFontSize: size }),
      setTerminalLineHeight: (height) => set({ terminalLineHeight: height }),
      setTerminalFontId: (fontId) => set({ terminalFontId: fontId }),

      addEditorHistory: (text) =>
        set((state) => ({
          editorHistory: [text, ...state.editorHistory.slice(0, 49)],
        })),

      setEditorDraft: (draftKey, text) =>
        set((state) => ({
          editorDrafts: {
            ...state.editorDrafts,
            [draftKey]: text,
          },
        })),

      removeEditorDraft: (draftKey) =>
        set((state) => {
          if (!(draftKey in state.editorDrafts)) {
            return state;
          }
          const nextDrafts = { ...state.editorDrafts };
          delete nextDrafts[draftKey];
          return { editorDrafts: nextDrafts };
        }),
    }),
    {
      name: 'tmex-ui',
      // sidebarTab 不持久化：每次加载都回到默认 'panes'。
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        inputMode: state.inputMode,
        editorSendWithEnter: state.editorSendWithEnter,
        theme: state.theme,
        editorHistory: state.editorHistory,
        editorDrafts: state.editorDrafts,
        terminalFontSize: state.terminalFontSize,
        terminalLineHeight: state.terminalLineHeight,
        terminalFontId: state.terminalFontId,
      }),
      // 丢弃旧版本 localStorage 里残留的 sidebarTab，避免被默认 merge 带回。
      merge: (persisted, current) => {
        const { sidebarTab: _ignored, ...rest } = (persisted ?? {}) as Partial<UIState>;
        return { ...current, ...rest };
      },
    }
  )
);
