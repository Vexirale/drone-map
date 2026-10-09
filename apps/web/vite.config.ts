import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The API server (apps/server) listens on PORT from .env, 3000 by default. In dev the Vite server
 * proxies /api and /health to it, so the browser only ever talks to one origin (APP_ORIGIN,
 * http://localhost:5173) and session cookies and the server's origin check just work.
 * In production the API server serves the built files from dist/ itself.
 */
const apiServer = 'http://localhost:3000';
const proxy = { '/api': apiServer, '/health': apiServer };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Fail instead of moving to another port: the server only accepts requests from APP_ORIGIN.
    strictPort: true,
    proxy,
  },
  preview: { port: 5173, strictPort: true, proxy },
  build: { outDir: 'dist' },
});
