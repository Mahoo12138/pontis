import React from 'react';
import ReactDOM from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import '@mantine/core/styles.css';
import '../../theme/pontisTheme.css';
import { pontisTheme } from '../../theme/pontisTheme';
import { App } from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider theme={pontisTheme} defaultColorScheme="auto">
      <App />
    </MantineProvider>
  </React.StrictMode>,
);
