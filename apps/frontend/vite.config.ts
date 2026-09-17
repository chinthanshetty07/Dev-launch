import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const BACKEND = process.env.DEVLAUNCH_BACKEND ?? 'http://localhost:3939';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    // The backend owns /api and the log socket; proxying keeps the browser on one
    // origin so there is no CORS surface to configure.
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/ws': { target: BACKEND, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
