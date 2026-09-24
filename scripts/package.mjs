/**
 * Zips dist/ into the artifact uploaded to the Chrome Web Store.
 *
 * Deliberately zips only what the build produced: no source, no vendor/, no
 * node_modules, no store-assets/ (those are listing material, not part of the
 * extension package).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
if (!existsSync(dist)) throw new Error('dist/ not found — run `npm run build` first');

const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));
const outDir = resolve(root, 'artifacts');
mkdirSync(outDir, { recursive: true });

const zipPath = resolve(outDir, `exporter-${manifest.version}.zip`);
rmSync(zipPath, { force: true });

// -X drops macOS extended attributes and resource forks, which otherwise show
// up in the package as __MACOSX entries and confuse Web Store review.
execFileSync('zip', ['-r', '-X', '-q', zipPath, '.'], { cwd: dist, stdio: 'inherit' });
console.log(`packaged ${zipPath}`);
