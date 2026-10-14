import { style } from '@vanilla-extract/css';
import { tokens } from './semantic-tokens.css';

/**
 * Styles for the space analytics view.
 *
 * Flat by rule, not by taste: docs/23 §20 excludes cards from KPI-style
 * surfaces and DESIGN.md:284 bans shadow on main surfaces, so every block here
 * is a hairline-bordered region with rows divided inside it. One box per
 * region — a bordered row inside a bordered card inside a card would break the
 * One-Box Rule (DESIGN.md:298).
 */

export const section = style({
  backgroundColor: tokens.workspaceBg,
  border: `1px solid ${tokens.subtleBorder}`,
  borderRadius: 8,
  overflow: 'hidden',
});

export const sectionHeader = style({
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  padding: '10px 14px',
  borderBottom: `1px solid ${tokens.subtleBorder}`,
});

export const sectionBody = style({
  padding: '12px 14px',
});

/** A divided line inside a section; every row but the last draws its rule. */
export const row = style({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '7px 14px',
  fontSize: 13,
  selectors: {
    '&:not(:last-child)': { borderBottom: `1px solid ${tokens.subtleBorder}` },
  },
});

/**
 * Headline numbers, as one dense strip rather than a card grid.
 *
 * docs/23 §21 sanctions "compact rows with counts on the right" for aggregate
 * views and explicitly rejects the KPI card array, so the totals read as a
 * sentence: label then value, 13px, tabular figures, no hero number.
 */
export const readout = style({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px 22px',
});

export const readoutItem = style({
  display: 'inline-flex',
  alignItems: 'baseline',
  gap: 6,
});

export const readoutLabel = style({
  fontSize: 12,
  color: tokens.textSecondary,
});

export const readoutValue = style({
  fontSize: 13,
  fontWeight: 600,
  color: tokens.textPrimary,
  fontVariantNumeric: 'tabular-nums',
});

/**
 * One ranking row: label, bar, value.
 *
 * The label column is a fixed width rather than `1fr`, so every bar starts at
 * the same x. Bars that begin at different offsets cannot be compared by
 * length, and comparison is the only job a ranking bar has.
 */
export const barRow = style({
  display: 'grid',
  gridTemplateColumns: '168px minmax(0, 1fr) auto',
  alignItems: 'center',
  gap: 12,
  padding: '7px 14px',
  selectors: {
    '&:hover': { backgroundColor: tokens.hoverBg },
  },

  '@media': {
    '(max-width: 720px)': { gridTemplateColumns: '112px minmax(0, 1fr) auto' },
  },
});

export const barLabel = style({
  fontSize: 14,
  color: tokens.textPrimary,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

/**
 * The well the bar sits in. Drawing the full extent is what lets a short bar
 * read as "small" rather than "missing"; without it, 12 and 454 look like two
 * arbitrary stubs.
 */
export const barTrack = style({
  height: 10,
  borderRadius: 2,
  backgroundColor: tokens.raisedBg,
  overflow: 'hidden',
  minWidth: 0,
});

/**
 * Graphite for the field, one accent for the leader.
 *
 * The system allows exactly one filled accent per surface and warns against
 * large blue fields (DESIGN.md One Voice / No-Blue-Field, docs/23:150).
 * Painting every bar blue broke both; painting none left the chart with no
 * anchor. The brand's own graphite carries the comparison and the accent names
 * the top.
 */
export const barFill = style({
  height: '100%',
  borderRadius: 2,
  backgroundColor: tokens.textSecondary,
});

export const barFillLead = style({
  backgroundColor: tokens.accent,
});

/** Numbers are measurement: mono + tabular so a column of them aligns. */
export const barValue = style({
  textAlign: 'right',
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
  fontVariantNumeric: 'tabular-nums',
  fontSize: 13,
  fontWeight: 600,
  color: tokens.textPrimary,
  whiteSpace: 'nowrap',
});

export const barNote = style({
  fontWeight: 400,
  color: tokens.textSecondary,
});

/**
 * The plot area. Bars touch each other because a histogram's subject is the
 * silhouette of a distribution, and gaps between columns invent breaks that
 * are not in the data. The bottom rule is the baseline the bars stand on.
 */
export const histogram = style({
  display: 'flex',
  alignItems: 'flex-end',
  gap: 2,
  height: 132,
  borderBottom: `1px solid ${tokens.subtleBorder}`,
});

export const histogramColumn = style({
  flex: 1,
  minWidth: 0,
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-end',
});

export const histogramBar = style({
  width: '100%',
  borderRadius: '2px 2px 0 0',
  backgroundColor: tokens.textSecondary,
});

/** Exactly one band gets the accent: the mode of the distribution. */
export const histogramBarLead = style({
  backgroundColor: tokens.accent,
});

/**
 * The count, hugging the top of its bar.
 *
 * Mono + tabular so a column of them aligns, and primary weight because in a
 * distribution the number is the answer — the bar only shows its shape.
 */
export const histogramCount = style({
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
  fontVariantNumeric: 'tabular-nums',
  fontSize: 12,
  fontWeight: 600,
  color: tokens.textPrimary,
  textAlign: 'center',
  marginBottom: 4,
});

/**
 * A zero band gets no bar at all.
 *
 * An earlier version drew a 2px grey stub for empty bands, which reads as "a
 * very small value" rather than none — the one thing a distribution must not
 * misreport. The bare baseline plus a disabled zero says "empty" instead.
 */
export const histogramCountEmpty = style({
  color: tokens.textDisabled,
  fontWeight: 400,
});

/** Axis labels live under the baseline so the rule stays unbroken. */
export const histogramAxis = style({
  display: 'flex',
  gap: 2,
  marginTop: 6,
});

export const histogramLabel = style({
  flex: 1,
  minWidth: 0,
  fontSize: 12,
  fontWeight: 500,
  color: tokens.textSecondary,
  textAlign: 'center',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

/** A path rendered as breadcrumb-ish text inside a list row. */
export const pathText = style({
  color: tokens.textSecondary,
  fontSize: 12,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const emptyState = style({
  padding: '26px 14px',
  textAlign: 'center',
  color: tokens.textSecondary,
  fontSize: 13,
});

/** A caveat line. Used where a number could be misread as something wider. */
export const caveat = style({
  fontSize: 12,
  color: tokens.textSecondary,
  margin: 0,
});
