import { style } from '@vanilla-extract/css';
import { tokens } from './semantic-tokens.css';

/** Plaza card grid — 2-3 columns, flat cards, no waterfall. */

export const plazaGrid = style({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
  gap: 12,

  '@media': {
    '(max-width: 1023px)': {
      gridTemplateColumns: '1fr',
    },
  },
});

export const pubCard = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '14px 16px',
  backgroundColor: tokens.workspaceBg,
  border: `1px solid ${tokens.subtleBorder}`,
  borderRadius: 8,
  cursor: 'pointer',
  transition: 'background-color 100ms ease',
  textAlign: 'left',

  selectors: {
    '&:hover': { backgroundColor: tokens.hoverBg },
    '&:focus-visible': {
      outline: `2px solid ${tokens.accent}`,
      outlineOffset: 1,
    },
  },
});

export const pubCardTitle = style({
  fontSize: 14,
  fontWeight: 600,
  color: tokens.textPrimary,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const pubCardMeta = style({
  fontSize: 12,
  color: tokens.textSecondary,
});

export const pubTag = style({
  fontSize: 11,
  color: tokens.textSecondary,
  padding: '1px 8px',
  backgroundColor: tokens.raisedBg,
  border: `1px solid ${tokens.subtleBorder}`,
  borderRadius: 4,
  width: 'fit-content',
});
