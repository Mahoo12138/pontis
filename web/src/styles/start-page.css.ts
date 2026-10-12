import { style } from '@vanilla-extract/css';
import { tokens } from './semantic-tokens.css';

/** Start page — the bookmark tree's quick-access view, not a second workbench.
 * Sparser than the Explorer, still a tool: no marketing hero, no background
 * image, no shadow on a card that is not a floating layer (§10). */

export const page = style({
  // <body> is overflow:hidden for the workbench's fixed panes; this page is a
  // document and scrolls on its own.
  height: '100%',
  overflowY: 'auto',
  backgroundColor: tokens.appBg,
  color: tokens.textPrimary,
});

export const inner = style({
  maxWidth: tokens.startPageWidth,
  margin: '0 auto',
  padding: '0 24px 40px',
});

export const header = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  height: tokens.headerHeight,
});

export const brand = style({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  fontSize: '14px',
  fontWeight: 600,
  color: tokens.textPrimary,
  textDecoration: 'none',
});

export const headerActions = style({
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
});

export const searchArea = style({
  display: 'flex',
  justifyContent: 'center',
  // The one generous measurement on the page: the search box needs room to be
  // the first thing a new tab is read for.
  paddingTop: tokens.startPageTopSpace,
  paddingBottom: '32px',
  '@media': {
    // A short window is a working window, not a poster: the space comes back
    // to the bookmarks instead of holding the composition.
    '(max-height: 700px)': {
      paddingTop: '28px',
      paddingBottom: '20px',
    },
  },
});

export const searchBox = style({
  width: '100%',
  maxWidth: tokens.startPageSearchWidth,
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  height: tokens.startPageControl,
  padding: '0 6px 0 10px',
  border: `1px solid ${tokens.subtleBorder}`,
  borderRadius: tokens.startPageRadius,
  backgroundColor: tokens.workspaceBg,
  '@media': {
    '(max-width: 720px)': {
      maxWidth: '100%',
    },
  },
});

export const searchInput = style({
  flex: 1,
  minWidth: 0,
  height: '100%',
  border: 'none',
  outline: 'none',
  background: 'transparent',
  fontSize: '14px',
  color: tokens.textPrimary,
  selectors: {
    '&::placeholder': {
      color: tokens.textDisabled,
    },
  },
});

export const modeSwitch = style({
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  height: '30px',
  padding: '0 8px',
  border: 'none',
  borderRadius: '6px',
  backgroundColor: 'transparent',
  fontSize: '12px',
  color: tokens.textSecondary,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  selectors: {
    '&:hover': {
      backgroundColor: tokens.hoverBg,
    },
  },
});

export const modeSwitchActive = style({
  color: tokens.accent,
  backgroundColor: tokens.selectedBg,
});

export const scopeLine = style({
  margin: '-16px 0 20px',
  textAlign: 'center',
  fontSize: '12px',
  color: tokens.textSecondary,
});

export const navRow = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '16px',
  marginBottom: '12px',
  minHeight: '28px',
  flexWrap: 'wrap',
});

export const breadcrumb = style({
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  flexWrap: 'wrap',
  minWidth: 0,
  fontSize: '13px',
  color: tokens.textSecondary,
});

export const crumb = style({
  padding: '2px 6px',
  border: 'none',
  borderRadius: '6px',
  background: 'transparent',
  fontSize: '13px',
  color: tokens.textSecondary,
  cursor: 'pointer',
  maxWidth: '240px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  selectors: {
    '&:hover': {
      backgroundColor: tokens.hoverBg,
      color: tokens.textPrimary,
    },
  },
});

export const crumbGroup = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  minWidth: 0,
});

export const crumbCurrent = style({
  color: tokens.textPrimary,
  fontWeight: 500,
  cursor: 'default',
  selectors: {
    '&:hover': {
      backgroundColor: 'transparent',
    },
  },
});

export const grid = style({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'grid',
  // 4-6 columns on a desktop row, fewer as the window narrows, without the
  // page needing a breakpoint per column count.
  gridTemplateColumns: 'repeat(auto-fill, minmax(184px, 1fr))',
  gap: tokens.startPageGap,
});

/** A grid cell. Without the min-width a long unbroken title would set the
 * column's content size and push the page wider than it is. */
export const gridItem = style({
  minWidth: 0,
});

export const gridCompact = style({
  gap: tokens.startPageGapCompact,
  gridTemplateColumns: 'repeat(auto-fill, minmax(156px, 1fr))',
});

/** One entry: a folder to walk into, or a bookmark to open. */
export const entry = style({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  // The card fills its grid column: an entry that only covers its own text
  // makes the clickable area depend on how long a title happens to be.
  width: '100%',
  minHeight: tokens.startPageCard,
  padding: '0 12px',
  border: 'none',
  borderRadius: tokens.startPageRadius,
  backgroundColor: 'transparent',
  color: tokens.textPrimary,
  textAlign: 'left',
  cursor: 'pointer',
  textDecoration: 'none',
  overflow: 'hidden',
  transition: 'background-color 100ms',
  selectors: {
    '&:hover': {
      backgroundColor: tokens.hoverBg,
    },
  },
});

export const entryCompact = style({
  minHeight: tokens.startPageCardCompact,
  gap: '8px',
  padding: '0 10px',
});

export const entryIcon = style({
  flexShrink: 0,
  width: tokens.startPageIcon,
  height: tokens.startPageIcon,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '16px',
  color: tokens.textSecondary,
});

export const entryText = style({
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
});

export const entryTitle = style({
  fontSize: '14px',
  lineHeight: '18px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const entryMeta = style({
  fontSize: '12px',
  lineHeight: '16px',
  color: tokens.textSecondary,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

/** The rare actions on an entry — copy, manage — sitting at the right edge.
 * They stay visible rather than appearing on hover: an affordance only a mouse
 * user can find is not an affordance, and these rows are the ones with no
 * other way out (§6.3 keeps the rest of the chrome off the card). */
export const entryActions = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '2px',
  marginLeft: 'auto',
  flexShrink: 0,
});

export const quietAction = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  fontSize: '13px',
  color: tokens.textSecondary,
  textDecoration: 'none',
  selectors: {
    '&:hover': {
      color: tokens.accent,
    },
  },
});

export const statusLine = style({
  marginTop: '24px',
  fontSize: '12px',
  color: tokens.textDisabled,
  textAlign: 'right',
});

export const notice = style({
  marginBottom: '16px',
  padding: '8px 12px',
  borderRadius: '6px',
  fontSize: '13px',
  backgroundColor: tokens.raisedBg,
  color: tokens.textSecondary,
});

export const noticeStrong = style({
  backgroundColor: tokens.selectedBg,
  color: tokens.textPrimary,
});

export const centeredState = style({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '12px',
  padding: '48px 24px',
  textAlign: 'center',
  color: tokens.textSecondary,
  fontSize: '13px',
});

/** First load with no cache to show: the shape of the page stays, so the
 * refresh does not read as the content changing. */
export const skeleton = style({
  height: tokens.startPageCard,
  borderRadius: tokens.startPageRadius,
  backgroundColor: tokens.raisedBg,
});

/* ─── Search ─────────────────────────────────────────────────────────────── */

/** The result list is the only floating layer on this page, so it is the only
 * thing allowed a shadow (§10). */
export const searchResults = style({
  position: 'absolute',
  top: 'calc(100% + 6px)',
  left: 0,
  right: 0,
  maxHeight: 420,
  overflowY: 'auto',
  margin: 0,
  padding: '4px',
  listStyle: 'none',
  border: `1px solid ${tokens.subtleBorder}`,
  borderRadius: tokens.startPageRadius,
  backgroundColor: tokens.workspaceBg,
  boxShadow: '0 4px 16px rgba(16, 24, 40, 0.10)',
  zIndex: 10,
});

export const searchWrap = style({
  position: 'relative',
  width: '100%',
  maxWidth: tokens.startPageSearchWidth,
  '@media': {
    '(max-width: 720px)': {
      maxWidth: '100%',
    },
  },
});

export const searchRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '8px 10px',
  borderRadius: '6px',
  border: 'none',
  width: '100%',
  background: 'transparent',
  color: tokens.textPrimary,
  textAlign: 'left',
  cursor: 'pointer',
  selectors: {
    '&[data-selected="true"]': {
      backgroundColor: tokens.focusBg,
    },
    '&:hover': {
      backgroundColor: tokens.hoverBg,
    },
  },
});

export const searchRowText = style({
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
});

export const searchRowTitle = style({
  fontSize: '14px',
  lineHeight: '18px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const searchRowPath = style({
  fontSize: '12px',
  lineHeight: '16px',
  color: tokens.textSecondary,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const searchEmpty = style({
  padding: '14px 10px',
  fontSize: '13px',
  color: tokens.textSecondary,
});
