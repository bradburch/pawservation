import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fillPlanPrices } from './server/lib/plan-pricing.js';

export default defineConfig({
  plugins: [
    react(),
    // demo.html states the plan prices; this fills them from PRICING so no figure is typed there.
    {
      name: 'plan-prices',
      transformIndexHtml: { order: 'pre', handler: (html: string) => fillPlanPrices(html) },
    },
  ],
  build: {
    rollupOptions: {
      input: {
        embed: resolve(import.meta.dirname, 'embed.html'),
        admin: resolve(import.meta.dirname, 'admin.html'),
        demo: resolve(import.meta.dirname, 'demo.html'),
        setup: resolve(import.meta.dirname, 'setup.html'),
      },
    },
  },
});
