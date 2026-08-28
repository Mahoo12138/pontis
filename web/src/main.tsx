import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PontisProvider } from './theme/provider';

import './styles/global.css.ts';
import './i18n';

import App from './app';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
    mutations: {
      retry: 0,
    },
  },
});

async function bootstrap() {
  // Start MSW for gap endpoints in development
  if (import.meta.env.DEV) {
    const mockMode = import.meta.env.VITE_API_MOCK ?? 'partial';
    if (mockMode !== 'off') {
      const { startMsw } = await import('@pontis/api/mock/server');
      await startMsw(mockMode as 'partial' | 'all');
    }
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <PontisProvider>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </PontisProvider>
    </React.StrictMode>,
  );
}

bootstrap();
