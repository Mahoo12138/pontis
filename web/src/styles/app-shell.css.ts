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
});

export const workspaceRegion = style({
  gridColumn: '2',
  gridRow: '1',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  backgroundColor: tokens.workspaceBg,
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
