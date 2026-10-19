/** Set by wxt.config.ts from PONTIS_NEWTAB, so the UI can say which of the two
 * artifacts this is rather than describing a switch that does not exist. */
declare const __PONTIS_NEWTAB_BUILD__: boolean;

/** The installed build's own identity, never read from the connected server. */
declare const __PONTIS_BUILD_METADATA__: {
  release: string;
  commit: string;
  dirty: boolean;
};
