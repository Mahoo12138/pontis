import { style, keyframes } from '@vanilla-extract/css';
import { tokens } from './semantic-tokens.css';

/**
 * Shared styles for the Management World pages
 * (Devices, Backups, Users, Jobs, Settings).
 */

export const pagePad = style({
  padding: '16px 24px',
});

export const sectionTitle = style({
  fontSize: 13,
  fontWeight: 600,
  color: tokens.textPrimary,
  margin: 0,
});

export const sectionHint = style({
  fontSize: 12,
  color: tokens.textSecondary,
  margin: 0,
});

/** Monospace for revisions, ids, secrets, timestamps. */
export const mono = style({
  fontFamily:
    'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
  fontSize: 12,
});

export const statusDot = style({
  display: 'inline-block',
  width: 8,
  height: 8,
  borderRadius: '50%',
  flexShrink: 0,
});

export const syncPulse = keyframes({
  '0%, 100%': { opacity: 1 },
  '50%': { opacity: 0.35 },
});

export const statusDotPulsing = style({
  animation: `${syncPulse} 1.6s ease-in-out infinite`,

  '@media': {
    '(prefers-reduced-motion: reduce)': {
      animation: 'none',
    },
  },
});

/** Compact table row that only highlights on hover. */
export const rowHover = style({
  selectors: {
    '&:hover': { backgroundColor: tokens.hoverBg },
  },
});

/** Sub-row (expanded detail) surface. */
export const detailRow = style({
  backgroundColor: tokens.raisedBg,
});
