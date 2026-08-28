import { createGlobalTheme } from '@vanilla-extract/css';

/** Pontis semantic design tokens. All derive from Mantine CSS variables. */
export const pontisTokens = createGlobalTheme(':root', {
  // ─── Surfaces ─────────────────────────────────────
  appBg: 'var(--mantine-color-body)',
  workspaceBg: 'var(--mantine-color-white)',
  sidebarBg: 'var(--mantine-color-coolGray-0)',
  raisedBg: 'var(--mantine-color-default-hover)',

  // ─── Borders ──────────────────────────────────────
  subtleBorder: 'var(--mantine-color-coolGray-2)',

  // ─── Interactive states ───────────────────────────
  hoverBg: 'var(--mantine-color-coolGray-1)',
  selectedBg: 'var(--mantine-color-accentBlue-0)',
  focusRing: 'var(--mantine-color-accentBlue-3)',

  // ─── Sync status ──────────────────────────────────
  syncHealthy: 'var(--mantine-color-healthyGreen-6)',
  syncWarning: 'var(--mantine-color-warningAmber-6)',
  syncRecovery: 'var(--mantine-color-recoveryOrange-6)',
  syncError: 'var(--mantine-color-errorRed-6)',

  // ─── Layout dimensions ────────────────────────────
  sidebarWidth: '224px',
  headerHeight: '56px',
  toolbarHeight: '44px',
  explorerRow: '38px',
  smallControl: '30px',
  normalControl: '34px',
  inspectorWidth: '300px',
});
