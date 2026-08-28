import { style } from '@vanilla-extract/css';
import { pontisTokens } from './semantic-tokens.css';

/** Bookmark Explorer styles — file-manager-style list. */

export const explorerContainer = style({
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
});

export const explorerColumnHeader = style({
  display: 'flex',
  alignItems: 'center',
  height: '36px',
  padding: '0 16px',
  fontSize: '12px',
  fontWeight: 500,
  color: 'var(--mantine-color-coolGray-5)',
  borderBottom: `1px solid ${pontisTokens.subtleBorder}`,
  userSelect: 'none',
});

export const explorerRow = style({
  display: 'flex',
  alignItems: 'center',
  height: pontisTokens.explorerRow,
  padding: '0 16px',
  fontSize: '14px',
  color: 'var(--mantine-color-coolGray-8)',
  cursor: 'pointer',
  transition: 'background-color 100ms',
  borderBottom: `1px solid transparent`,
  selectors: {
    '&:hover': {
      backgroundColor: pontisTokens.hoverBg,
    },
  },
});

export const explorerRowSelected = style({
  backgroundColor: pontisTokens.selectedBg,
});

export const explorerRowFocused = style({
  backgroundColor: 'var(--mantine-color-accentBlue-1)',
});

export const explorerRowIcon = style({
  flexShrink: 0,
  color: 'var(--mantine-color-coolGray-5)',
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
  fontSize: '12px',
  color: 'var(--mantine-color-coolGray-5)',
  marginLeft: '16px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const explorerRowTime = style({
  flexShrink: 0,
  fontSize: '12px',
  color: 'var(--mantine-color-coolGray-5)',
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
