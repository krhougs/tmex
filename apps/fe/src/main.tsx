import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { RootLayout } from './layouts/RootLayout';
import { LoginPage } from './pages/LoginPage';
import { DevicesPage } from './pages/DevicesPage';
import { DevicePage } from './pages/DevicePage';
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
    path: '/login',
    element: <LoginPage />,
  },
  {
    path: '/',
    element: <RootLayout />,
    children: [
      {
        path: 'devices',
        element: <DevicesPage />,
      },
      {
        path: 'devices/:deviceId',
        element: <DevicePage />,
      },
      {
        path: 'devices/:deviceId/windows/:windowId/panes/:paneId',
        element: <DevicePage />,
      },
      {
        path: '',
        element: <DevicesPage />,
      },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>
);
