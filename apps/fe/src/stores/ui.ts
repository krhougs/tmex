import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UIState {
  sidebarCollapsed: boolean;
  inputMode: 'direct' | 'editor';
  editorHistory: string[];
  setSidebarCollapsed: (collapsed: boolean) => void;
  setInputMode: (mode: 'direct' | 'editor') => void;
  addEditorHistory: (text: string) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      inputMode: 'direct',
      editorHistory: [],
      
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setInputMode: (mode) => set({ inputMode: mode }),
      
      addEditorHistory: (text) =>
        set((state) => ({
          editorHistory: [text, ...state.editorHistory.slice(0, 49)],
        })),
    }),
    {
      name: 'tmex-ui',
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        inputMode: state.inputMode,
        editorHistory: state.editorHistory,
      }),
    }
  )
);
