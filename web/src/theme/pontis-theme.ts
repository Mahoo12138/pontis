import { createTheme, type MantineColorsTuple } from '@mantine/core';

// ─── Color tuples (10 shades each) ──────────────────────────

/** Low-saturation cool blue — interaction color only. */
const accentBlue: MantineColorsTuple = [
  '#f0f4ff', // 0 — very light (selected bg)
  '#dce4f7', // 1
  '#b8c9ed', // 2
  '#8ea8de', // 3
  '#6889d0', // 4
  '#4f72c8', // 5 — primary accent
  '#3f62c0', // 6 — hover
  '#2e4fa5', // 7 — active
  '#1e3d8b', // 8
  '#0d2b71', // 9
];

/** Cool gray — surfaces, text hierarchy, borders. */
const coolGray: MantineColorsTuple = [
  '#f8f9fa', // 0 — app background
  '#f1f3f5', // 1 — hover background
  '#e7e9ec', // 2 — border
  '#d1d5db', // 3
  '#9ca3af', // 4 — disabled text
  '#6b717a', // 5 — secondary text
  '#4b5563', // 6
  '#374151', // 7
  '#202329', // 8 — primary text
  '#111827', // 9
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

// ─── Theme ──────────────────────────────────────────────────

export const pontisTheme = createTheme({
  // Colors
  primaryColor: 'accentBlue',
  colors: {
    accentBlue,
    coolGray,
    healthyGreen,
    warningAmber,
    recoveryOrange,
    errorRed,
  },

  // Typography
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif',
  fontFamilyMonospace:
    'ui-monospace, SFMono-Regular, Consolas, monospace',
  headings: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif',
    fontWeight: '600',
  },

  // Font sizes — compact per design system
  fontSizes: {
    xs: '11px',
    sm: '12px',
    md: '13px',
    lg: '14px',
    xl: '16px',
  },

  // Spacing — Mantine default 4px base
  spacing: {
    xs: '4px',
    sm: '8px',
    md: '12px',
    lg: '16px',
    xl: '20px',
  },

  // Radius — small per design system
  radius: {
    xs: '4px',
    sm: '6px', // Button, Input, Selected
    md: '8px', // Menu, Popover, Card
    lg: '10px', // Dialog
    xl: '12px',
  },

  // Shadows — floating surfaces only
  shadows: {
    xs: '0 1px 2px rgba(0,0,0,0.06)',
    sm: '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)',
    md: '0 4px 6px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.06)',
    lg: '0 8px 16px rgba(0,0,0,0.1), 0 4px 8px rgba(0,0,0,0.06)',
    xl: '0 12px 24px rgba(0,0,0,0.12), 0 6px 12px rgba(0,0,0,0.08)',
  },

  // Component defaults — compact density, set once in theme
  components: {
    Button: {
      defaultProps: { size: 'sm' },
      styles: { root: { fontWeight: 500 } },
    },
    ActionIcon: {
      defaultProps: { size: 'sm' },
    },
    TextInput: {
      defaultProps: { size: 'sm' },
    },
    NumberInput: {
      defaultProps: { size: 'sm' },
    },
    PasswordInput: {
      defaultProps: { size: 'sm' },
    },
    Select: {
      defaultProps: { size: 'sm' },
    },
    Badge: {
      defaultProps: { size: 'sm' },
    },
    Menu: {
      defaultProps: { shadow: 'sm' },
    },
    Tooltip: {
      defaultProps: { shadow: 'sm' },
    },
    Popover: {
      defaultProps: { shadow: 'sm' },
    },
    Modal: {
      defaultProps: { radius: 'lg', shadow: 'md' },
    },
    Drawer: {
      defaultProps: { shadow: 'md' },
    },
    Table: {
      defaultProps: {
        highlightOnHover: true,
        horizontalSpacing: 'sm',
        verticalSpacing: 'xs',
      },
    },
    Checkbox: {
      defaultProps: { size: 'sm' },
    },
    Switch: {
      defaultProps: { size: 'sm' },
    },
  },

  // Other
  cursorType: 'default',
  defaultRadius: 'sm',
  focusRing: 'auto',
  white: '#ffffff',
  black: '#111315', // Graphite, not pure black
});
