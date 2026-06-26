import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        embed: resolve(import.meta.dirname, 'embed.html'),
        admin: resolve(import.meta.dirname, 'admin.html'),
        demo: resolve(import.meta.dirname, 'demo.html'),
      },
    },
  },
});
