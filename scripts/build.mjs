/**
 * Produces dist/, a loadable unpacked extension.
 *
 * Three passes, because MV3 wants two different module formats:
 *   1. ES modules  — service worker + popup/options pages
 *   2. IIFE bundles — content scripts injected with chrome.scripting, which
 *      Chrome loads as classic scripts and which therefore cannot have imports
 *   3. static copy  — manifest.json, _locales/, icons/
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Must run before Vite is loaded, and Vite must therefore be imported
// dynamically below: a static import is linked before any module body executes,
// so on an unsupported Node the process would die inside rolldown with an
// unreadable error before this check ever got a turn.
import './require-node.mjs';

const { build, loadConfigFromFile } = await import('vite');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `--test` produces dist-test/ instead: an otherwise identical build whose
 * manifest also carries host_permissions for <all_urls>.
 *
 * Playwright cannot click a real toolbar icon, and activeTab is only granted by
 * that click — so without a host permission the e2e suite could never inject
 * anything. This build exists solely so those tests can run against the real
 * extension. package.mjs only ever zips dist/, so it cannot be shipped.
 */
const isTestBuild = process.argv.includes('--test');
const dist = resolve(root, isTestBuild ? 'dist-test' : 'dist');

// vite.config.ts stays the single source of truth for aliases and build target;
// loadConfigFromFile is how a plain-JS script reads a TypeScript config.
const loaded = await loadConfigFromFile(
  { command: 'build', mode: 'production' },
  resolve(root, 'vite.config.ts'),
);
if (!loaded) throw new Error('could not load vite.config.ts');
const baseConfig = loaded.config;

/** Injected on demand, so each must be a single self-contained classic script. */
const CONTENT_SCRIPTS = {
  'content/element-picker': 'src/content/element-picker.ts',
  'content/page-readiness': 'src/content/page-readiness.ts',
  'content/pdf-via-canvas': 'src/export/pdf-via-canvas.ts',
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const withOutDir = (config) => ({
  ...config,
  build: { ...config.build, outDir: dist },
});

console.log(`· building service worker and extension pages -> ${relative(root, dist)}/`);
await build({ configFile: false, ...withOutDir(baseConfig), logLevel: 'warn' });

for (const [name, entry] of Object.entries(CONTENT_SCRIPTS)) {
  console.log(`· building content script ${name}`);
  await build({
    configFile: false,
    ...baseConfig,
    logLevel: 'warn',
    // jsPDF references `import.meta`, which has no meaning in a classic script.
    // Nothing this extension calls reads it, and the alternative — shipping the
    // fallback renderer as an ES module — is not an option: chrome.scripting
    // loads injected files as classic scripts.
    define: { ...baseConfig.define, 'import.meta': '{}' },
    build: {
      ...baseConfig.build,
      outDir: dist,
      emptyOutDir: false,
      rollupOptions: {
        input: resolve(root, entry),
        output: {
          // A classic script has no import mechanism: everything, vendored
          // libraries included, has to land in this one file.
          format: 'iife',
          entryFileNames: `${name}.js`,
        },
      },
    },
  });
}

console.log('· copying manifest, locales and icons');
const STATIC = [
  ['manifest.json', 'manifest.json'],
  ['_locales', '_locales'],
  ['src/icons', 'icons'],
];
for (const [from, to] of STATIC) {
  const source = resolve(root, from);
  if (!existsSync(source)) throw new Error(`missing build input: ${from}`);
  cpSync(source, resolve(dist, to), { recursive: true });
}

if (isTestBuild) {
  const manifestPath = resolve(dist, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.name = 'exporter (test build — do not publish)';
  manifest.host_permissions = ['<all_urls>'];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('· patched manifest with <all_urls> for e2e');
}

console.log(
  `\n${relative(root, dist)}/ is ready — load it via chrome://extensions -> Load unpacked`,
);
