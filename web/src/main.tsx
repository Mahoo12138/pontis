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
  // The MSW shell mocks a session and /meta only; data still comes from the
  // proxied backend. It has to be asked for by name — a missing VITE_API_MOCK
  // used to fall through to 'all', which left a developer looking at a logged-in
  // app whose lists were served by nothing.
  if (import.meta.env.DEV && import.meta.env.VITE_API_MOCK === 'on') {
    const { startMsw } = await import('@pontis/api/mock/server');
    await startMsw();
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
