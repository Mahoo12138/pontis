// Port of web/src/theme/pontis-theme.ts — the Pontis design system, so the
// replica UI and the web app are the same product. Keep the tuples, scale and
// component defaults in sync with that file; scheme-specific colors live in
// pontisTheme.css, which maps the *Dark palettes over Mantine's own vars the
// way the web semantic-token layer does.

import { createTheme, type MantineColorsTuple } from '@mantine/core';

/** Low-saturation cool blue — interaction color only. */
const accentBlue: MantineColorsTuple = [
  '#f0f4ff', '#dce4f7', '#b8c9ed', '#8ea8de', '#6889d0',
  '#4f72c8', '#3f62c0', '#2e4fa5', '#1e3d8b', '#0d2b71',
];

/** Cool gray — surfaces, text hierarchy, borders. */
const coolGray: MantineColorsTuple = [
  '#f8f9fa', '#f1f3f5', '#e7e9ec', '#d1d5db', '#9ca3af',
  '#6b717a', '#4b5563', '#374151', '#202329', '#111827',
];

/** Gray-green for healthy sync status. */
const healthyGreen: MantineColorsTuple = [
  '#f0faf0', '#d1f0d1', '#a3e0a3', '#6bcb6b', '#4db84d',
  '#3da63d', '#2f932f', '#237823', '#185d18', '#0d420d',
];

/** Soft amber for warnings. */
const warningAmber: MantineColorsTuple = [
  '#fef9ee', '#fcefc4', '#f9df8a', '#f5cb4d', '#f0b820',
  '#e5a510', '#cc8f0a', '#a67408', '#7f5706', '#583b04',
];

/** Soft orange for recovery. */
const recoveryOrange: MantineColorsTuple = [
  '#fff4ee', '#fde2cc', '#fbc599', '#f8a05f', '#f57d2e',
  '#e56618', '#cc5213', '#a24010', '#7a2f0d', '#531e0a',
];

/** Soft red for errors. */
const errorRed: MantineColorsTuple = [
  '#fef1f0', '#fcd9d6', '#f8b0aa', '#f08078', '#e8544c',
  '#dc362e', '#c42a24', '#9f201c', '#7a1614', '#550d0c',
];

// Graphite Dark palettes: mapped for dark scheme in pontisTheme.css.
const graphite: MantineColorsTuple = [
  '#111315', '#17191C', '#1D2024', '#22262B', '#2A2D31',
  '#4B5563', '#6B717A', '#9CA3AF', '#E5E7EB', '#F3F4F6',
];

const accentBlueDark: MantineColorsTuple = [
  '#1E2A42', '#24334F', '#2A3B5C', '#2F5078', '#386594',
  '#4F72C8', '#5E82D6', '#7A9BE0', '#96B4EA', '#B2CDF4',
];

const healthyGreenDark: MantineColorsTuple = [
  '#0F1F0F', '#1A3A1A', '#265526', '#327032', '#3D8B3D',
  '#4DB84D', '#62CA62', '#7DD87D', '#9EE59E', '#BEF1BE',
];

const warningAmberDark: MantineColorsTuple = [
  '#1F1808', '#3A2E0F', '#554418', '#705A20', '#8B7028',
  '#E5A510', '#F0B820', '#F5CB4D', '#F9DF8A', '#FCEFC4',
];

const recoveryOrangeDark: MantineColorsTuple = [
  '#1F140A', '#3A250F', '#553615', '#70471B', '#8B5820',
  '#E56618', '#F57D2E', '#F8A05F', '#FBC599', '#FDE2CC',
];

const errorRedDark: MantineColorsTuple = [
  '#1F0E0C', '#3A1A17', '#552623', '#70332E', '#8B403A',
  '#DC362E', '#E8544C', '#F08078', '#F8B0AA', '#FCD9D6',
];

export const pontisTheme = createTheme({
  primaryColor: 'accentBlue',
  colors: {
    accentBlue,
    coolGray,
    healthyGreen,
    warningAmber,
    recoveryOrange,
    errorRed,
    graphite,
    accentBlueDark,
    healthyGreenDark,
    warningAmberDark,
    recoveryOrangeDark,
    errorRedDark,
  },

  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  headings: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif',
    fontWeight: '600',
  },

  // Compact density: the settings page is read, not browsed.
  fontSizes: { xs: '11px', sm: '12px', md: '13px', lg: '14px', xl: '16px' },
  spacing: { xs: '4px', sm: '8px', md: '12px', lg: '16px', xl: '20px' },
  radius: { xs: '4px', sm: '6px', md: '8px', lg: '10px', xl: '12px' },
  shadows: {
    xs: '0 1px 2px rgba(0,0,0,0.06)',
    sm: '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)',
    md: '0 4px 6px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.06)',
    lg: '0 8px 16px rgba(0,0,0,0.1), 0 4px 8px rgba(0,0,0,0.06)',
    xl: '0 12px 24px rgba(0,0,0,0.12), 0 6px 12px rgba(0,0,0,0.08)',
  },

  components: {
    Button: { defaultProps: { size: 'sm' }, styles: { root: { fontWeight: 500 } } },
    TextInput: { defaultProps: { size: 'sm' } },
    PasswordInput: { defaultProps: { size: 'sm' } },
    Select: { defaultProps: { size: 'sm' } },
    Badge: { defaultProps: { size: 'sm' } },
    Table: {
      defaultProps: { highlightOnHover: true, horizontalSpacing: 'sm', verticalSpacing: 'xs' },
      // Column headers are metadata, not content (docs/23 §18.3): secondary
      // text at medium weight so a table header never outranks a row.
      styles: { th: { color: 'var(--mantine-color-coolGray-5)', fontWeight: 500 } },
    },
    Tooltip: { defaultProps: { shadow: 'sm', openDelay: 200 } },
  },

  cursorType: 'default',
  defaultRadius: 'sm',
  focusRing: 'auto',
  white: '#ffffff',
  black: '#111315',
});
