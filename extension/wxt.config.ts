import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Pontis',
    description: 'Pontis self-hosted bookmark sync — browser replica',
    permissions: ['bookmarks', 'storage', 'alarms'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
  },
});
