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

export default defineConfig({
  srcDir: 'src',
  ...(e2eOrigin ? { outDir: '.e2e-output' } : {}),
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: e2eOrigin ? 'Pontis (E2E)' : 'Pontis',
    description: 'Pontis self-hosted bookmark sync — browser replica',
    permissions: ['bookmarks', 'storage', 'alarms'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    ...(e2eOrigin ? { host_permissions: [e2eOrigin] } : {}),
  },
});
