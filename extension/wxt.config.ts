import { defineConfig } from 'wxt';

// E2E-only build switch (scripts/e2e-dual-profile.mjs sets these).
//
// Pairing asks Chrome for the server's host permission, and that grant bubble
// is browser UI: no automation can click it, so a clean-profile end-to-end run
// cannot get past pairing unless the origin is already in the manifest. The
// switch puts it in `host_permissions` for that one build and writes it to a
// separate directory, so `.output/chrome-mv3` — the artifact people load by hand
// and the one that ships — is never the permissive build.
const e2eOrigin = process.env.PONTIS_E2E_ORIGIN;

/**
 * New-tab takeover is a build choice, not a setting.
 *
 * `chrome_url_overrides` is read when the extension installs, and no API
 * changes it afterwards — so "use Pontis as my new tab" cannot be a toggle
 * inside the standard extension. It is a second artifact, built from the same
 * code and the same start-page component (start-page doc §9.1, §9.3).
 *
 * The default build drops the entrypoint entirely: a `newtab` directory left in
 * the source tree would make every ordinary upgrade of the sync extension start
 * owning the new tab, which is exactly what §9.2 forbids.
 */
const newtabBuild = process.env.PONTIS_NEWTAB === '1';

export default defineConfig({
  srcDir: 'src',
  // Separate output directories, so installing one never looks like an update
  // of the other and the two cannot overwrite each other's artifact.
  outDir: newtabBuild ? '.output-newtab' : e2eOrigin ? '.e2e-output' : '.output',
  modules: ['@wxt-dev/module-react'],
  hooks: {
    'entrypoints:resolved'(_wxt, entrypoints) {
      if (newtabBuild) return;
      const at = entrypoints.findIndex((e) => e.name === 'newtab');
      if (at >= 0) entrypoints.splice(at, 1);
    },
    // The settings page says which of the two this build is. A reader cannot
    // tell from the icon, and §8.3 refuses a label that guesses.
    'vite:build:extendConfig'(_entrypoints, config) {
      config.define = { ...config.define, __PONTIS_NEWTAB_BUILD__: JSON.stringify(newtabBuild) };
    },
  },
  manifest: {
    name: e2eOrigin ? 'Pontis (E2E)' : newtabBuild ? 'Pontis (起始页)' : 'Pontis',
    description: 'Pontis self-hosted bookmark sync — browser replica',
    // `search` is here for one call: handing a typed query to the browser's
    // own default search provider. It is not a site-access permission, and the
    // start page asks for nothing else (§16.4).
    permissions: ['bookmarks', 'storage', 'alarms', 'search'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    ...(e2eOrigin ? { host_permissions: [e2eOrigin] } : {}),
  },
});
