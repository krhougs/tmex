import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { Toaster } from 'sonner';
import { RootLayout } from './layouts/RootLayout';
import { DevicePage } from './pages/DevicePage';
import { DevicesPage } from './pages/DevicesPage';
import { SettingsPage } from './pages/SettingsPage';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: 1,
    },
  },
});

const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    children: [
      {
        path: 'settings',
        element: <SettingsPage />,
      },
      {
        path: 'devices',
        element: <DevicesPage />,
      },
      {
        path: 'devices/:deviceId/windows/:windowId/panes/:paneId',
        element: <DevicePage />,
      },
      {
        path: 'devices/:deviceId',
        element: <DevicePage />,
      },
      {
        path: '',
        element: <DevicesPage />,
      },
    ],
  },
]);

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster
        richColors
        position="top-right"
        closeButton
        toastOptions={{
          duration: 6000,
        }}
      />
    </QueryClientProvider>
  </StrictMode>
);
