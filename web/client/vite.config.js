import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // A plain '/api' key is a prefix match and would also swallow the SPA route /api-keys.
    proxy: { '^/api(/|$)': { target: process.env.LQTTS_API ?? 'http://127.0.0.1:8760' } },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Dependencies in their own chunk: the app chunk stays well under the 500 kB warning, and a release that only
    // changes app code leaves the cached vendor file valid.
    rolldownOptions: { output: { codeSplitting: { groups: [{ name: 'vendor', test: /node_modules/ }] } } },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    css: false,
    include: ['src/**/*.test.{js,jsx}'],
  },
});
