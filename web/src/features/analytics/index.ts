/**
 * Headless analytics logic for a bookmark space.
 *
 * Everything here is pure: no React, no fetching, no DOM. The explorer feature
 * module (features/explorer) set this shape, and it is what makes these
 * functions testable — `web` has no jsdom, so anything that touched a node
 * would be untestable.
 */
export * from './buckets';
export * from './host';
export * from './structure';
export * from './urls';
export * from './titles';
export * from './tokens';
export * from './timeline';
