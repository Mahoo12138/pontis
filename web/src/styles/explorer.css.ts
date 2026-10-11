import { style } from '@vanilla-extract/css';
import { tokens } from './semantic-tokens.css';

/** Bookmark Explorer styles — file-manager-style list. */

export const explorerContainer = style({
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  selectors: {
    // The tree is one tab stop (rows are moved between with the arrows), so
    // landing on it has to be visible.
    '&:focus-visible': {
      outline: `2px solid ${tokens.accent}`,
      outlineOffset: '-2px',
    },
  },
});

export const explorerColumnHeader = style({
  display: 'flex',
  alignItems: 'center',
  height: tokens.explorerColumnHeader,
  padding: '0 16px',
  fontSize: '12px',
  fontWeight: 500,
  color: tokens.textSecondary,
  borderBottom: `1px solid ${tokens.subtleBorder}`,
  userSelect: 'none',
});

export const explorerRow = style({
  display: 'flex',
  alignItems: 'center',
  height: tokens.explorerRow,
  padding: '0 16px',
  fontSize: '14px',
  color: tokens.textPrimary,
  cursor: 'pointer',
  userSelect: 'none',
  transition: 'background-color 100ms',
  selectors: {
    '&:hover': {
      backgroundColor: tokens.hoverBg,
    },
  },
});

export const explorerRowSelected = style({
  backgroundColor: tokens.selectedBg,
});

export const explorerRowFocused = style({
  backgroundColor: tokens.focusBg,
});

export const explorerRowIcon = style({
  flexShrink: 0,
  color: tokens.textSecondary,
  marginRight: '8px',
});

export const explorerRowTitle = style({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const explorerRowTitleFolder = style({
  fontWeight: 500,
});

export const explorerRowMeta = style({
  flexShrink: 0,
  width: '200px',
  fontSize: '12px',
  color: tokens.textSecondary,
  marginLeft: '16px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const explorerRowTime = style({
  flexShrink: 0,
  fontSize: '12px',
  color: tokens.textSecondary,
  marginLeft: '16px',
  width: '60px',
  textAlign: 'right',
});

export const explorerRowActions = style({
  flexShrink: 0,
  marginLeft: '8px',
  display: 'flex',
  gap: '2px',
  opacity: 0,
  transition: 'opacity 100ms',
  selectors: {
    [`${explorerRow}:hover &`]: {
      opacity: 1,
    },
    // A control that only appears for the mouse is invisible to the keyboard.
    [`${explorerRow}:focus-within &`]: {
      opacity: 1,
    },
  },
});

/**
 * Context-menu rows. The menu is a list of buttons the keyboard walks with the
 * arrows, so the focused item needs the same affordance the hovered one has.
 */
export const contextMenuItem = style({
  selectors: {
    '&:hover': {
      backgroundColor: tokens.hoverBg,
    },
    '&:focus-visible': {
      backgroundColor: tokens.hoverBg,
      outline: `1px solid ${tokens.accent}`,
      outlineOffset: '-1px',
    },
  },
});

/** Favicon — natural color element in the list. */
export const favicon = style({
  width: '16px',
  height: '16px',
  flexShrink: 0,
  marginRight: '8px',
  borderRadius: '2px',
  objectFit: 'contain',
});
