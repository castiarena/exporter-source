/**
 * Fails the build if anything in dist/ could reach the network or evaluate code
 * it did not ship with.
 *
 * This is the automated half of the security pass in 01-requirements.md §4 and
 * the "grep the built dist/ for http" sanity check in 03-build-prompts.md phase
 * 4. It runs against the *built* output, not src/, so anything a dependency
 * drags in through a bundle is caught too.
 *
 * Two tiers:
 *
 *  - First-party output — the service worker, both extension pages, the shared
 *    chunks, and the two hand-written content scripts. Zero tolerance: any hit
 *    here is a bug.
 *
 *  - content/pdf-via-canvas.js — the only bundle containing vendored library
 *    code (jsPDF, html2canvas). Their unused API surface still ships, so each
 *    surviving reference is enumerated below with the reason it cannot execute.
 *    An unrecognised hit in this file still fails, which is the point: a
 *    dependency bump that adds a new network path cannot slip through.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

const SCANNED = new Set(['.js', '.html', '.css', '.json']);

/** The one built file that contains third-party code. */
const VENDOR_BUNDLE = 'content/pdf-via-canvas.js';

const RULES = [
  { id: 'remote-url', pattern: /\bhttps?:\/\/[^\s"'`)\\]+/gi },
  { id: 'network-api', pattern: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\s*\(/g },
  { id: 'dynamic-code', pattern: /\b(?:eval\s*\(|new\s+Function\s*\()/g },
];

/**
 * Namespace URIs are identifiers written into PDF/SVG metadata, never fetched.
 * They are allowed everywhere because a document that embeds one is not making
 * a request.
 */
const NAMESPACE_URIS = [
  /^https?:\/\/www\.w3\.org\//i,
  /^https?:\/\/purl\.org\//i,
  /^https?:\/\/ns\.adobe\.com\//i,
  /^https?:\/\/iptc\.org\//i,
  /^https?:\/\/jspdf\.default\.namespaceuri\//i,
];

/**
 * Everything the vendored libraries leave behind, and why each one is inert.
 * Anything not on this list fails the check.
 */
const VENDOR_ALLOWANCES = [
  {
    match: /^https?:\/\/(html2canvas\.hertzen\.com|hertzen\.com|parall\.ax|www\.yworks\.com|github\.com|opensource\.org)/i,
    why: 'Attribution and licence URLs in the vendored library headers — string literals in comments-turned-constants, never requested.',
  },
  {
    match: /^https?:\/\/(www\.phpied\.com|www\.myersdaily\.org|www\.fpdf\.org|www\.cs\.cmu\.edu)/i,
    why: 'Provenance credits for algorithms jsPDF ported (colour parsing, MD5, RC4). Comment text, not endpoints.',
  },
  {
    match: /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pdfobject\//i,
    why:
      "jsPDF's output('pdfobjectnewwindow') injects this script to preview a PDF in a new window. " +
      'This extension only ever calls output(\'datauristring\') (src/export/pdf-via-canvas.ts), so the ' +
      'branch is unreachable; the extension CSP would block the injected script regardless.',
  },
  {
    match: /^XMLHttpRequest\($/,
    why:
      "html2canvas feature-detects XHR support, and uses XHR only when its `proxy` option is set — " +
      'this extension never sets it, and html2canvas throws "No proxy defined" rather than falling back ' +
      'to a default. jsPDF\'s copy is in its save()/file-download helper, which this extension does not call.',
  },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

const findings = [];
for (const file of walk(dist)) {
  if (!SCANNED.has(extname(file))) continue;
  const rel = relative(dist, file).split('\\').join('/');
  const isVendorBundle = rel === VENDOR_BUNDLE;
  const text = readFileSync(file, 'utf8');

  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const hit = match[0];
      if (NAMESPACE_URIS.some((allowed) => allowed.test(hit))) continue;
      if (isVendorBundle && VENDOR_ALLOWANCES.some((allowed) => allowed.match.test(hit))) continue;
      const line = text.slice(0, match.index).split('\n').length;
      findings.push({ file: rel, line, rule: rule.id, hit: hit.slice(0, 120) });
    }
  }
}

if (findings.length > 0) {
  console.error(`\n${findings.length} unreviewed remote-code / network reference(s) in dist/:\n`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.rule}]  ${f.hit}`);
  console.error(
    '\nRemove the reference, or — if it is inert vendored code — add it to\n' +
      'VENDOR_ALLOWANCES in scripts/verify-no-remote.mjs with the reason it\n' +
      'cannot execute. First-party output must have no hits at all.\n',
  );
  process.exit(1);
}

console.log(
  'dist/ verified: no first-party network calls, no dynamic code evaluation,\n' +
    'and every vendored reference accounted for.',
);
