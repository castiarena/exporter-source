import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// `import.meta.dirname` needs Node 20; this form works on the Node 18 floor in
// package.json's engines field.
const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * Base config shared by every build pass in scripts/build.mjs.
 *
 * @crxjs/vite-plugin is the recommendation in 02-project-structure.md §1, which
 * also allows any comparable bundler. Plain Vite is used here because MV3 needs
 * two different output formats — ES modules for the service worker and the
 * extension pages, self-contained IIFEs for scripts injected with
 * chrome.scripting.executeScript — and driving those as explicit passes is more
 * predictable than configuring a plugin to infer them.
 */
export default defineConfig({
  root: resolve(root, 'src'),
  publicDir: false,
  // No dev server is involved: an unpacked extension is loaded from dist/.
  base: './',
  resolve: {
    alias: [
      // jspdf.es.min.js's only bare import. Vendored so the graph never leaves
      // vendor/ (see scripts/vendor.mjs).
      {
        find: '@babel/runtime/helpers/typeof',
        replacement: resolve(root, 'vendor/babel-runtime/typeof.js'),
      },
      // jsPDF lazily import()s these from its unused .html() API. Aliasing them
      // to a throwing stub keeps them out of the bundle entirely.
      { find: /^canvg$/, replacement: resolve(root, 'vendor/stubs/unavailable-module.js') },
      { find: /^dompurify$/, replacement: resolve(root, 'vendor/stubs/unavailable-module.js') },
      { find: /^html2canvas$/, replacement: resolve(root, 'vendor/stubs/unavailable-module.js') },
    ],
  },
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: false,
    target: 'chrome116',
    // Chrome supports modulepreload natively, and the polyfill Vite would
    // otherwise inline uses fetch() — a network API this extension must not
    // ship at all (see scripts/verify-no-remote.mjs).
    modulePreload: { polyfill: false },
    // Sourcemaps would ship the full original source inside the store package.
    sourcemap: false,
    minify: true,
    rollupOptions: {
      input: {
        'background/service-worker': resolve(root, 'src/background/service-worker.ts'),
        'popup/popup': resolve(root, 'src/popup/popup.html'),
        'options/options': resolve(root, 'src/options/options.html'),
      },
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
