import type { MantineColorsTuple } from '@mantine/core';

/** Graphite Dark color overrides. Applied when colorScheme is 'dark'. */

/** Dark cool gray — layered dark surfaces, not pure black. */
export const darkCoolGray: MantineColorsTuple = [
  '#1D2024', // 0 — raised surface
  '#17191C', // 1 — workspace
  '#252830', // 2
  '#2A2D31', // 3 — border
  '#4B5563', // 4 — disabled text
  '#6B717A', // 5 — secondary text
  '#9CA3AF', // 6
  '#D1D5DB', // 7
  '#E5E7EB', // 8 — primary text
  '#F3F4F6', // 9
];

/** Accent blue shifted brighter for dark backgrounds. */
export const darkAccentBlue: MantineColorsTuple = [
  '#1a2332', // 0
  '#1e2d42', // 1
  '#263d5c', // 2
  '#2f5078', // 3
  '#386594', // 4
  '#4f72c8', // 5 — primary accent (same hue, slightly boosted)
  '#5e82d6', // 6 — hover
  '#7a9be0', // 7 — active
  '#96b4ea', // 8
  '#b2cdf4', // 9
];

export const darkHealthyGreen: MantineColorsTuple = [
  '#0f1f0f', '#1a3a1a', '#265526', '#327032', '#3d8b3d',
  '#4db84d', '#62ca62', '#7dd87d', '#9ee59e', '#bef1be',
];

export const darkWarningAmber: MantineColorsTuple = [
  '#1f1808', '#3a2e0f', '#554418', '#705a20', '#8b7028',
  '#e5a510', '#f0b820', '#f5cb4d', '#f9df8a', '#fcefc4',
];

export const darkRecoveryOrange: MantineColorsTuple = [
  '#1f140a', '#3a250f', '#553615', '#70471b', '#8b5820',
  '#e56618', '#f57d2e', '#f8a05f', '#fbc599', '#fde2cc',
];

export const darkErrorRed: MantineColorsTuple = [
  '#1f0e0c', '#3a1a17', '#552623', '#70332e', '#8b403a',
  '#dc362e', '#e8544c', '#f08078', '#f8b0aa', '#fcd9d6',
];

/** All dark mode color overrides to merge into Mantine theme. */
export const darkColorOverrides = {
  coolGray: darkCoolGray,
  accentBlue: darkAccentBlue,
  healthyGreen: darkHealthyGreen,
  warningAmber: darkWarningAmber,
  recoveryOrange: darkRecoveryOrange,
  errorRed: darkErrorRed,
};
