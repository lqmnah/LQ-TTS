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
  build: { outDir: 'dist', sourcemap: false },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    css: false,
    include: ['src/**/*.test.{js,jsx}'],
  },
});
