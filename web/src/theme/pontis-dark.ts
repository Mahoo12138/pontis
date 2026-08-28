import type { MantineColorsTuple } from '@mantine/core';

/**
 * Graphite Dark palettes (design system §6).
 *
 * These are registered in the Mantine theme (see pontis-theme.ts) so their
 * CSS variables (--mantine-color-*) exist. The semantic token layer
 * (styles/semantic-tokens.css.ts) maps them for `data-mantine-color-scheme="dark"`.
 */

/** Graphite Dark layered surfaces — index meaning:
 *  0 app background · 1 workspace · 2 raised surface · 3 hover · 4 border
 *  5 disabled text · 6 muted · 7 secondary text · 8 primary text · 9 bright */
export const graphite: MantineColorsTuple = [
  '#111315', // 0 — app background (never pure black)
  '#17191C', // 1 — workspace
  '#1D2024', // 2 — raised surface
  '#22262B', // 3 — hover
  '#2A2D31', // 4 — border
  '#4B5563', // 5 — disabled text
  '#6B717A', // 6 — muted
  '#9CA3AF', // 7 — secondary text
  '#E5E7EB', // 8 — primary text (not overly bright white)
  '#F3F4F6', // 9
];

/** Accent blue shifted brighter for dark backgrounds. */
export const accentBlueDark: MantineColorsTuple = [
  '#1E2A42', // 0 — selected bg (deep blue-gray)
  '#24334F', // 1 — focus bg
  '#2A3B5C', // 2
  '#2F5078', // 3
  '#386594', // 4
  '#4F72C8', // 5 — primary accent
  '#5E82D6', // 6 — hover / active
  '#7A9BE0', // 7
  '#96B4EA', // 8
  '#B2CDF4', // 9
];

export const healthyGreenDark: MantineColorsTuple = [
  '#0F1F0F', '#1A3A1A', '#265526', '#327032', '#3D8B3D',
  '#4DB84D', '#62CA62', '#7DD87D', '#9EE59E', '#BEF1BE',
];

export const warningAmberDark: MantineColorsTuple = [
  '#1F1808', '#3A2E0F', '#554418', '#705A20', '#8B7028',
  '#E5A510', '#F0B820', '#F5CB4D', '#F9DF8A', '#FCEFC4',
];

export const recoveryOrangeDark: MantineColorsTuple = [
  '#1F140A', '#3A250F', '#553615', '#70471B', '#8B5820',
  '#E56618', '#F57D2E', '#F8A05F', '#FBC599', '#FDE2CC',
];

export const errorRedDark: MantineColorsTuple = [
  '#1F0E0C', '#3A1A17', '#552623', '#70332E', '#8B403A',
  '#DC362E', '#E8544C', '#F08078', '#F8B0AA', '#FCD9D6',
];
