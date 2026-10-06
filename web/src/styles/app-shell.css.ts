import { style } from '@vanilla-extract/css';
import { tokens } from './semantic-tokens.css';

/** App shell — sidebar + workspace grid layout. */

export const shell = style({
  display: 'grid',
  gridTemplateColumns: `${tokens.sidebarWidth} 1fr`,
  gridTemplateRows: '1fr',
  height: '100vh',
  overflow: 'hidden',
  backgroundColor: tokens.appBg,

  '@media': {
    '(max-width: 1023px)': {
      gridTemplateColumns: '1fr',
    },
  },
});

export const sidebarRegion = style({
  gridColumn: '1',
  gridRow: '1',
  backgroundColor: tokens.sidebarBg,
  borderRight: `1px solid ${tokens.subtleBorder}`,
  overflowY: 'auto',
  overflowX: 'hidden',
  display: 'flex',
  flexDirection: 'column',

  // Below the breakpoint the sidebar becomes a slide-in overlay.
  '@media': {
    '(max-width: 1023px)': {
      position: 'fixed',
      top: 0,
      bottom: 0,
      left: 0,
      width: tokens.sidebarWidth,
      zIndex: 100,
      transform: 'translateX(-100%)',
      transition: 'transform 150ms ease',
    },
  },
});

export const sidebarRegionOpen = style({
  '@media': {
    '(max-width: 1023px)': {
      transform: 'translateX(0)',
    },
  },
});

export const sidebarBackdrop = style({
  '@media': {
    '(min-width: 1024px)': { display: 'none' },
    '(max-width: 1023px)': {
      display: 'block',
      position: 'fixed',
      inset: 0,
      zIndex: 99,
      backgroundColor: 'rgba(0, 0, 0, 0.4)',
    },
  },
});

/** Hamburger shown only below the 1024px breakpoint. */
export const sidebarMenuButton = style({
  display: 'none',

  '@media': {
    '(max-width: 1023px)': {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 30,
      height: 30,
      border: 'none',
      borderRadius: 6,
      backgroundColor: 'transparent',
      color: tokens.textSecondary,
      cursor: 'pointer',
    },
  },

  selectors: {
    '&:hover': { backgroundColor: tokens.hoverBg },
  },
});

export const workspaceRegion = style({
  gridColumn: '2',
  gridRow: '1',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  backgroundColor: tokens.workspaceBg,

  // The shell collapses to a single column below the breakpoint;
  // span the full row so no implicit empty column is created.
  '@media': {
    '(max-width: 1023px)': {
      gridColumn: '1 / -1',
    },
  },
});

/** Header bar within workspace. */
export const headerRegion = style({
  flexShrink: 0,
  height: tokens.headerHeight,
  display: 'flex',
  alignItems: 'center',
  padding: '0 16px',
  gap: '12px',
  borderBottom: `1px solid ${tokens.subtleBorder}`,
});

/** Toolbar row within workspace, below header. */
export const toolbarRegion = style({
  flexShrink: 0,
  height: tokens.toolbarHeight,
  display: 'flex',
  alignItems: 'center',
  padding: '0 16px',
  gap: '8px',
  borderBottom: `1px solid ${tokens.subtleBorder}`,
});

/** Main content area within workspace, scrollable. */
export const contentRegion = style({
  flex: 1,
  overflowY: 'auto',
  overflowX: 'hidden',
});
