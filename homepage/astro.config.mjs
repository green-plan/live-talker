// @ts-check
import { defineConfig } from 'astro/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import license from 'rollup-plugin-license';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// https://astro.build/config
export default defineConfig({
  site: 'https://green-plan.github.io',
  base: '/live-talker',
  vite: {
    plugins: [
      tailwindcss(),
      // Generates the third-party license file linked from the footer's
      // "Built on Open Source" link. Writes straight into the build output
      // (not public/) so it's always in sync with what actually shipped.
      license({
        thirdParty: {
          output: path.join(rootDir, 'dist', 'third-party-licenses.txt'),
        },
      }),
    ]
  }
});