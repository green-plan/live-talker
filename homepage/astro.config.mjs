// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://green-plan.github.io',
  base: '/live-talker',
  vite: {
    plugins: [tailwindcss()]
  }
});