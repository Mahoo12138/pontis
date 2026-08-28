import {
  createGlobalThemeContract,
  createGlobalTheme,
} from '@vanilla-extract/css';

/** kebab-case a camelCase token key. */
const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

/**
 * Pontis semantic design tokens.
 *
 * Single semantic layer over the Mantine theme: light values map to the
 * light palettes, dark values map to the Graphite Dark palettes — all
 * registered in theme/pontis-theme.ts, so no second color system exists.
 *
 * Mantine sets `data-mantine-color-scheme` on <html>; the dark selector
 * (element + attribute) outranks :root, so dark values win in dark mode.
 */
export const tokens = createGlobalThemeContract(
  {
    // Surfaces
    appBg: null,
    workspaceBg: null,
    sidebarBg: null,
    raisedBg: null,
    // Borders
    subtleBorder: null,
    // Interactive states
    hoverBg: null,
    selectedBg: null,
    focusBg: null,
    // Text
    textPrimary: null,
    textSecondary: null,
    textDisabled: null,
    // Accent (interaction color only)
    accent: null,
    // Sync status
    syncHealthy: null,
    syncWarning: null,
    syncRecovery: null,
    syncError: null,
    // Layout dimensions
    sidebarWidth: null,
    headerHeight: null,
    toolbarHeight: null,
    explorerRow: null,
    explorerColumnHeader: null,
    smallControl: null,
    normalControl: null,
    inspectorWidth: null,
  },
  (_value, path) => `--pontis-${path.map(kebab).join('-')}`,
);

// ─── Layout dimensions (scheme-independent) ─────────────────
createGlobalTheme(':root', tokens, {
  appBg: 'var(--mantine-color-body)',
  workspaceBg: 'var(--mantine-color-white)',
  sidebarBg: 'var(--mantine-color-coolGray-0)',
  raisedBg: 'var(--mantine-color-coolGray-1)',
  subtleBorder: 'var(--mantine-color-coolGray-2)',
  hoverBg: 'var(--mantine-color-coolGray-1)',
  selectedBg: 'var(--mantine-color-accentBlue-0)',
  focusBg: 'var(--mantine-color-accentBlue-1)',
  textPrimary: 'var(--mantine-color-coolGray-8)',
  textSecondary: 'var(--mantine-color-coolGray-5)',
  textDisabled: 'var(--mantine-color-coolGray-4)',
  accent: 'var(--mantine-color-accentBlue-6)',
  syncHealthy: 'var(--mantine-color-healthyGreen-6)',
  syncWarning: 'var(--mantine-color-warningAmber-6)',
  syncRecovery: 'var(--mantine-color-recoveryOrange-6)',
  syncError: 'var(--mantine-color-errorRed-6)',
  sidebarWidth: '224px',
  headerHeight: '56px',
  toolbarHeight: '44px',
  explorerRow: '38px',
  explorerColumnHeader: '36px',
  smallControl: '30px',
  normalControl: '34px',
  inspectorWidth: '300px',
});

// ─── Dark (Graphite Dark) ────────────────────────────────────
createGlobalTheme("html[data-mantine-color-scheme='dark']", tokens, {
  appBg: 'var(--mantine-color-graphite-0)',
  workspaceBg: 'var(--mantine-color-graphite-1)',
  sidebarBg: 'var(--mantine-color-graphite-1)',
  raisedBg: 'var(--mantine-color-graphite-2)',
  subtleBorder: 'var(--mantine-color-graphite-4)',
  hoverBg: 'var(--mantine-color-graphite-3)',
  selectedBg: 'var(--mantine-color-accentBlueDark-0)',
  focusBg: 'var(--mantine-color-accentBlueDark-1)',
  textPrimary: 'var(--mantine-color-graphite-8)',
  textSecondary: 'var(--mantine-color-graphite-7)',
  textDisabled: 'var(--mantine-color-graphite-5)',
  accent: 'var(--mantine-color-accentBlueDark-6)',
  syncHealthy: 'var(--mantine-color-healthyGreenDark-6)',
  syncWarning: 'var(--mantine-color-warningAmberDark-6)',
  syncRecovery: 'var(--mantine-color-recoveryOrangeDark-6)',
  syncError: 'var(--mantine-color-errorRedDark-6)',
  sidebarWidth: '224px',
  headerHeight: '56px',
  toolbarHeight: '44px',
  explorerRow: '38px',
  explorerColumnHeader: '36px',
  smallControl: '30px',
  normalControl: '34px',
  inspectorWidth: '300px',
});
