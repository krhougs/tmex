import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router';
import { useTmuxStore } from '../stores/tmux';

const STORAGE_KEY = 'tmex:connectedDevices';

interface GlobalDeviceContextValue {
  persistedDevices: Set<string>;
  connectDevice: (deviceId: string) => void;
  disconnectDevice: (deviceId: string) => void;
  toggleDevice: (deviceId: string, isConnected: boolean) => void;
}

const GlobalDeviceContext = createContext<GlobalDeviceContextValue | null>(null);

export function useGlobalDevice(): GlobalDeviceContextValue {
  const ctx = useContext(GlobalDeviceContext);
  if (!ctx) {
    throw new Error('useGlobalDevice must be used within GlobalDeviceProvider');
  }
  return ctx;
}

interface GlobalDeviceProviderProps {
  children: React.ReactNode;
}

export function GlobalDeviceProvider({ children }: GlobalDeviceProviderProps) {
  const location = useLocation();
  const [persistedDevices, setPersistedDevices] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as string[];
        return new Set(parsed);
      }
    } catch {
      // 忽略 localStorage 错误
    }
    return new Set<string>();
  });

  const connectTmuxDevice = useTmuxStore((state) => state.connectDevice);
  const disconnectTmuxDevice = useTmuxStore((state) => state.disconnectDevice);
  const connectedDevices = useTmuxStore((state) => state.connectedDevices);

  // 持久化到 localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...persistedDevices]));
    } catch {
      // 忽略 localStorage 错误
    }
  }, [persistedDevices]);

  // 监听路由变化，自动连接当前设备
  useEffect(() => {
    const match = location.pathname.match(/^\/devices\/([^/]+)/);
    const currentDeviceId = match?.[1];

    if (currentDeviceId && !connectedDevices.has(currentDeviceId)) {
      connectTmuxDevice(currentDeviceId);
    }
  }, [location.pathname, connectedDevices, connectTmuxDevice]);

  const connectDevice = useCallback(
    (deviceId: string) => {
      setPersistedDevices((prev) => {
        const next = new Set(prev);
        next.add(deviceId);
        return next;
      });

      if (!connectedDevices.has(deviceId)) {
        connectTmuxDevice(deviceId);
      }
    },
    [connectedDevices, connectTmuxDevice]
  );

  const disconnectDevice = useCallback(
    (deviceId: string) => {
      setPersistedDevices((prev) => {
        const next = new Set(prev);
        next.delete(deviceId);
        return next;
      });

      if (connectedDevices.has(deviceId)) {
        disconnectTmuxDevice(deviceId);
      }
    },
    [connectedDevices, disconnectTmuxDevice]
  );

  const toggleDevice = useCallback(
    (deviceId: string, isConnected: boolean) => {
      if (isConnected) {
        disconnectDevice(deviceId);
      } else {
        connectDevice(deviceId);
      }
    },
    [connectDevice, disconnectDevice]
  );

  const value = useMemo(
    () => ({
      persistedDevices,
      connectDevice,
      disconnectDevice,
      toggleDevice,
    }),
    [persistedDevices, connectDevice, disconnectDevice, toggleDevice]
  );

  return <GlobalDeviceContext.Provider value={value}>{children}</GlobalDeviceContext.Provider>;
}
