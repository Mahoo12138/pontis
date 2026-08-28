import { style } from '@vanilla-extract/css';
import { pontisTokens } from './semantic-tokens.css';

/** App shell — sidebar + workspace grid layout. */

export const shell = style({
  display: 'grid',
  gridTemplateColumns: `${pontisTokens.sidebarWidth} 1fr`,
  gridTemplateRows: '1fr',
  height: '100vh',
  overflow: 'hidden',
  backgroundColor: pontisTokens.appBg,
});

export const sidebarRegion = style({
  gridColumn: '1',
  gridRow: '1',
  backgroundColor: pontisTokens.sidebarBg,
  borderRight: `1px solid ${pontisTokens.subtleBorder}`,
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
  backgroundColor: pontisTokens.workspaceBg,
});

/** Header bar within workspace. */
export const headerRegion = style({
  flexShrink: 0,
  height: pontisTokens.headerHeight,
  display: 'flex',
  alignItems: 'center',
  padding: '0 16px',
  borderBottom: `1px solid ${pontisTokens.subtleBorder}`,
});

/** Toolbar row within workspace, below header. */
export const toolbarRegion = style({
  flexShrink: 0,
  height: pontisTokens.toolbarHeight,
  display: 'flex',
  alignItems: 'center',
  padding: '0 16px',
  gap: '8px',
  borderBottom: `1px solid ${pontisTokens.subtleBorder}`,
});

/** Main content area within workspace, scrollable. */
export const contentRegion = style({
  flex: 1,
  overflowY: 'auto',
  overflowX: 'hidden',
});
