import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    vanillaExtractPlugin(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@pontis/api': path.resolve(__dirname, '../packages/api/src'),
      '@pontis/i18n': path.resolve(__dirname, '../packages/i18n/src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // :8081 — :8080 is commonly taken by OrbStack on dev machines.
      '/api': {
        target: process.env.PONTIS_API_URL ?? 'http://localhost:8081',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
