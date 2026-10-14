import { style } from '@vanilla-extract/css';
import { tokens } from './semantic-tokens.css';

/** Bookmark Explorer styles — file-manager-style list. */

/**
 * Keyboard-arrival ring. Driven by state rather than :focus-visible because
 * Chrome flips that pseudo-class on any keyboard modality — holding Shift to
 * extend a selection would ring the whole panel, which reads as a stray
 * selection box rather than "the tree has focus".
 */
export const explorerContainerRing = style({
  outline: `2px solid ${tokens.accent}`,
  outlineOffset: '-2px',
});

export const explorerContainer = style({
  display: 'flex',
  flexDirection: 'column',
  minHeight: '100%',
  // A rubber-band drag must not paint a text selection underneath it.
  userSelect: 'none',
  selectors: {
    // The app-wide `:focus-visible` ring is suppressed here; the list rings
    // itself through explorerContainerRing instead.
    [`&:focus-visible:not(.${explorerContainerRing})`]: {
      outline: 'none',
    },
  },
});

export const explorerColumnHeader = style({
  // Stays put while the list scrolls, so it needs an opaque background to
  // keep rows from sliding visibly underneath it.
  position: 'sticky',
  top: 0,
  zIndex: 1,
  display: 'flex',
  alignItems: 'center',
  height: tokens.explorerColumnHeader,
  padding: '0 16px',
  fontSize: '12px',
  fontWeight: 500,
  color: tokens.textSecondary,
  backgroundColor: tokens.workspaceBg,
  borderBottom: `1px solid ${tokens.subtleBorder}`,
  userSelect: 'none',
});

/** Rubber-band rectangle, drawn in viewport coordinates while dragging. */
export const explorerMarquee = style({
  position: 'fixed',
  zIndex: 50,
  pointerEvents: 'none',
  border: `1px solid ${tokens.accent}`,
  backgroundColor: tokens.selectedBg,
  opacity: 0.55,
  borderRadius: 2,
});

/** Ties a multi-selection to the action that works on all of it. */
export const explorerSelectionHint = style({
  flexShrink: 0,
  marginLeft: '16px',
  fontSize: '12px',
  fontWeight: 400,
  color: tokens.accent,
  whiteSpace: 'nowrap',
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
