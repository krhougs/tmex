import { create } from 'zustand';

interface AuthState {
  isAuthenticated: boolean | null;
  checkAuth: () => Promise<void>;
  login: (password: string) => Promise<boolean>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: null,

  checkAuth: async () => {
    try {
      const res = await fetch('/api/auth/me', {
        credentials: 'include',
      });
      set({ isAuthenticated: res.ok });
    } catch {
      set({ isAuthenticated: false });
    }
  },

  login: async (password: string) => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        set({ isAuthenticated: true });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  },

  logout: async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } finally {
      set({ isAuthenticated: false });
    }
  },
}));
