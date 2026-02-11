import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UIState {
  sidebarCollapsed: boolean;
  inputMode: 'direct' | 'editor';
  editorHistory: string[];
  editorDrafts: Record<string, string>;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setInputMode: (mode: 'direct' | 'editor') => void;
  addEditorHistory: (text: string) => void;
  setEditorDraft: (draftKey: string, text: string) => void;
  removeEditorDraft: (draftKey: string) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      inputMode: 'direct',
      editorHistory: [],
      editorDrafts: {},

      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setInputMode: (mode) => set({ inputMode: mode }),

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
        inputMode: state.inputMode,
        editorHistory: state.editorHistory,
        editorDrafts: state.editorDrafts,
      }),
    }
  )
);
