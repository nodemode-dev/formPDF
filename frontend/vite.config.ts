import { defineConfig } from 'vite';

const FRONTEND_PORT = 5198;
const BACKEND_PORT = 8198;
const engine = { target: `http://127.0.0.1:${BACKEND_PORT}`, changeOrigin: true, ws: true };

export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    fs: { allow: ['..'] },
    port: FRONTEND_PORT,
    host: false,
    strictPort: true,
    proxy: { '/api': engine, '/mcp': engine },
  },
  preview: {
    port: FRONTEND_PORT + 1,
    host: false,
    strictPort: true,
    proxy: { '/api': engine, '/mcp': engine },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1600,
  },
});
