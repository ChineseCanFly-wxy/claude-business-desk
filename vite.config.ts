import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => ({
  root: resolve(import.meta.dirname, 'apps/web'),
  plugins: [react()],
  build: { outDir: resolve(import.meta.dirname, 'dist/web'), emptyOutDir: true },
  server: {
    host: 'localhost',
    port: mode === 'client' ? 5311 : 5310,
    strictPort: true,
    proxy: { '/api': { target: mode === 'client' ? 'http://localhost:4311' : 'http://localhost:4310', changeOrigin: false } },
  },
}));
