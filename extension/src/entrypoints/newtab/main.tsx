import React from 'react';
import ReactDOM from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import '@mantine/core/styles.css';
import '../../theme/pontisTheme.css';
import { pontisTheme } from '../../theme/pontisTheme';
// The same page the popup opens. Two artifacts, one start page: a takeover
// build must not carry a second copy of the UI to drift.
import { App } from '../start-page/App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider theme={pontisTheme} defaultColorScheme="auto">
      <App />
    </MantineProvider>
  </React.StrictMode>,
);
