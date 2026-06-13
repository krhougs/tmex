import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SidebarTab = 'panes' | 'agent' | 'files';

interface UIState {
  sidebarCollapsed: boolean;
  sidebarTab: SidebarTab;
  inputMode: 'direct' | 'editor';
  editorSendWithEnter: boolean;
  theme: 'light' | 'dark';
  editorHistory: string[];
  editorDrafts: Record<string, string>;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setInputMode: (mode: 'direct' | 'editor') => void;
  setEditorSendWithEnter: (enabled: boolean) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  addEditorHistory: (text: string) => void;
  setEditorDraft: (draftKey: string, text: string) => void;
  removeEditorDraft: (draftKey: string) => void;
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

      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setSidebarTab: (tab) => set({ sidebarTab: tab }),
      setInputMode: (mode) => set({ inputMode: mode }),
      setEditorSendWithEnter: (enabled) => set({ editorSendWithEnter: enabled }),
      setTheme: (theme) => set({ theme }),

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
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        sidebarTab: state.sidebarTab,
        inputMode: state.inputMode,
        editorSendWithEnter: state.editorSendWithEnter,
        theme: state.theme,
        editorHistory: state.editorHistory,
        editorDrafts: state.editorDrafts,
      }),
    }
  )
);
