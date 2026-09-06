import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import { buildDefine } from './build-meta.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  define: buildDefine(),
  plugins: [react()],
  publicDir: 'vendor',
  server: {
    port: 7777,
    host: true,
    allowHosts: true,
    forwardConsole: {
      unhandledErrors: true,
      logLevels: ['info', 'warn', 'error'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        gameplay: path.resolve(__dirname, 'index.html'),
        author: path.resolve(__dirname, 'author/index.html'),
      },
      output: {
        // Engine-sized dependencies change much less often than the app code.
        // Keep them as explicit cache boundaries so a gameplay deployment does
        // not invalidate the browser's MapLibre/Three/React downloads.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/three/')) return 'vendor-three';
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
            return 'vendor-react';
          }
          return undefined;
        },
      },
    },
  },
});
