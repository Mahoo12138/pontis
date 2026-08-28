import { style } from '@vanilla-extract/css';
import { pontisTokens } from './semantic-tokens.css';

/** Sidebar-specific styles. */

export const sidebarLogo = style({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '12px 16px 8px',
  fontSize: '18px',
  fontWeight: 600,
  color: 'var(--mantine-color-coolGray-8)',
  letterSpacing: '-0.01em',
  userSelect: 'none',
});

export const sidebarSection = style({
  padding: '4px 8px',
});

export const sidebarSectionLabel = style({
  padding: '4px 8px',
  fontSize: '11px',
  fontWeight: 500,
  color: 'var(--mantine-color-coolGray-5)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  userSelect: 'none',
});

export const sidebarItem = style({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '6px 8px',
  borderRadius: '5px',
  fontSize: '13px',
  color: 'var(--mantine-color-coolGray-8)',
  cursor: 'pointer',
  transition: 'background-color 100ms',
  selectors: {
    '&:hover': {
      backgroundColor: pontisTokens.hoverBg,
    },
  },
});

export const sidebarItemSelected = style({
  backgroundColor: pontisTokens.selectedBg,
  color: 'var(--mantine-color-accentBlue-7)',
  fontWeight: 500,
});

export const sidebarDivider = style({
  margin: '6px 16px',
  border: 'none',
  borderTop: `1px solid ${pontisTokens.subtleBorder}`,
});

export const sidebarUser = style({
  marginTop: 'auto',
  padding: '8px 16px',
  borderTop: `1px solid ${pontisTokens.subtleBorder}`,
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  fontSize: '13px',
  color: 'var(--mantine-color-coolGray-5)',
});

export const sidebarItemIcon = style({
  color: 'var(--mantine-color-coolGray-5)',
  flexShrink: 0,
});
