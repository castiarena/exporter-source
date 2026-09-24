/**
 * Captures the Chrome Web Store listing images into store-assets/.
 *
 * Drives the real extension the same way the e2e suite does — dist-test/ loaded
 * unpacked into Playwright's Chromium — so every image shows the shipped UI, not
 * a mock-up. The staging page is store-assets/demo/article.html, a fictional
 * self-contained page served from localhost; nothing here touches the network.
 *
 * A toolbar popup cannot be screenshotted in place (it is browser UI, not page
 * content), so the popup is captured on its own and composited over the page
 * where the toolbar would drop it. Compositing runs in a second, extension-free
 * browser: once Page.printToPDF has run in the extension's browser, headless
 * Chromium paints later captures there with the frame repeated below itself.
 *
 * Output, all 24-bit PNG (no alpha) at the exact sizes the store accepts:
 *   store-assets/screenshots/01-popup.png    1280×800  popup over the page
 *   store-assets/screenshots/02-picker.png   1280×800  element picker mid-selection
 *   store-assets/screenshots/03-saved.png    1280×800  popup after a finished export
 *   store-assets/screenshots/04-options.png  1280×800  defaults page
 *   store-assets/promo-tile.png              440×280   small promo tile
 *   store-assets/marquee.png                 1400×560  marquee promo tile
 *
 * Every file is checked against its size and colour format before the script
 * exits: the store rejects images with an alpha channel.
 *
 * Prerequisites:  npm run build:test  &&  npx playwright install chromium
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import './require-node.mjs';

const { chromium } = await import('@playwright/test');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(root, 'dist-test');
const DEMO = resolve(root, 'store-assets/demo/article.html');
const SHOTS = resolve(root, 'store-assets/screenshots');
const PROMO = resolve(root, 'store-assets/promo-tile.png');
const MARQUEE = resolve(root, 'store-assets/marquee.png');

const SIZE = { width: 1280, height: 800 };

if (!existsSync(DIST)) throw new Error('dist-test/ not found — run `npm run build:test` first');
mkdirSync(SHOTS, { recursive: true });

// Served over HTTP for the same reason as in the e2e suite: file:// access needs
// a per-extension toggle that no command-line flag can grant.
const server = createServer((request, response) => {
  if ((request.url ?? '').split('?')[0] !== '/article.html') {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(readFileSync(DEMO));
});
const DEMO_URL = await new Promise((done) => {
  server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}/article.html`));
});

const userDataDir = mkdtempSync(join(tmpdir(), 'exporter-shots-'));
const downloadDir = mkdtempSync(join(tmpdir(), 'exporter-shots-dl-'));

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  viewport: SIZE,
  deviceScaleFactor: 1,
  colorScheme: 'light',
  locale: 'en-US',
  downloadsPath: downloadDir,
  acceptDownloads: true,
  args: ['--headless=new', `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--lang=en-US'],
});

const plain = await chromium.launch({ headless: true });

try {
  const started = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(started.url()).host;

  /** A live service worker; MV3 workers restart freely, so never cache one. */
  async function sw() {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const candidate = context.serviceWorkers()[0];
      if (candidate) {
        const ready = await candidate
          .evaluate(() => typeof chrome?.windows?.create === 'function')
          .catch(() => false);
        if (ready) return candidate;
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error('the extension service worker never became ready');
  }

  async function openDemo() {
    const page = await context.newPage();
    await page.goto(DEMO_URL);
    await page.bringToFront();
    return page;
  }

  /**
   * Opens the popup in its own window, so the demo page stays the active tab —
   * which is what the service worker resolves as the export target.
   */
  async function openPopup() {
    const worker = await sw();
    const appearing = context.waitForEvent('page');
    await worker.evaluate(
      (url) => chrome.windows.create({ url, type: 'popup', width: 360, height: 520 }),
      `chrome-extension://${extensionId}/popup/popup.html`,
    );
    const popup = await appearing;
    await popup.waitForLoadState();
    await popup.locator('#export-page').waitFor({ state: 'visible' });
    // Let the stored defaults load into the controls before capturing them.
    await popup.waitForFunction(() => document.querySelectorAll('#paper-size option').length > 0);
    return popup;
  }

  /** The popup's own pixels, cropped to its content. */
  const capturePopup = (popup) => popup.locator('body').screenshot({ animations: 'disabled' });

  /**
   * Lays the popup over a page capture where Chrome's toolbar would drop it:
   * top-right, just under the window edge, with the popup's own shadow.
   */
  async function composite(backgroundPng, popupPng, outPath) {
    const stage = await plain.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
    const src = (png) => `data:image/png;base64,${png.toString('base64')}`;
    await stage.setContent(`<!doctype html>
      <style>
        html, body { margin: 0; width: ${SIZE.width}px; height: ${SIZE.height}px; overflow: hidden; }
        .page { position: absolute; inset: 0; }
        .page::after { content: ''; position: absolute; inset: 0; background: rgb(0 0 0 / 0.08); }
        .popup { position: absolute; top: 12px; right: 20px; border-radius: 10px;
                 box-shadow: 0 12px 40px rgb(0 0 0 / 0.22), 0 0 0 1px rgb(0 0 0 / 0.08); }
      </style>
      <img class="page" src="${src(backgroundPng)}">
      <img class="popup" src="${src(popupPng)}">`);
    await stage.waitForFunction(() => Array.from(document.images).every((img) => img.complete));
    await stage.screenshot({ path: outPath });
    await stage.close();
  }

  const report = (path) => console.log(`· ${relative(root, path)}`);

  // 1. The popup, opened over the page it will export.
  {
    const page = await openDemo();
    const background = await page.screenshot();
    const popup = await openPopup();
    const out = join(SHOTS, '01-popup.png');
    await composite(background, await capturePopup(popup), out);
    report(out);
    await popup.close();
    await page.close();
  }

  // 2. The picker: the chart already picked, the pointer resting on the table.
  {
    const page = await openDemo();
    // Both cards on screen, clear of the picker's bar along the bottom edge.
    await page.evaluate(() => window.scrollTo(0, 300));
    const popup = await openPopup();
    await popup.click('#export-element');
    await page.waitForFunction(() => document.getElementById('exporter-picker-host') !== null);
    await page.click('#yield-chart');
    const table = await page.locator('#yield-table').boundingBox();
    if (!table) throw new Error('#yield-table is not on screen');
    // In the card's own padding, so the hover box outlines the card rather than
    // whichever cell happens to be under the pointer.
    await page.mouse.move(table.x + table.width - 10, table.y + table.height / 2);
    // The hover box follows the pointer on the next animation frame.
    await page.waitForTimeout(300);
    const out = join(SHOTS, '02-picker.png');
    await page.screenshot({ path: out });
    report(out);
    await page.keyboard.press('Escape');
    await popup.close();
    await page.close();
  }

  // 4. The defaults page. Captured before the export below, for the reason in
  //    the header comment.
  {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options/options.html`);
    await options.waitForFunction(() => document.querySelectorAll('#paper-size option').length > 0);
    const out = join(SHOTS, '04-options.png');
    await options.screenshot({ path: out });
    report(out);
    await options.close();
  }

  // 3. A finished export, with the saved filename in the popup's status line.
  //    The last capture taken in the extension's browser; see the header.
  {
    const page = await openDemo();
    const background = await page.screenshot();
    const popup = await openPopup();
    await popup.click('#export-page');
    await popup.waitForFunction(
      () => /success|error/.test(document.getElementById('status')?.dataset.phase ?? ''),
      undefined,
      { timeout: 45_000 },
    );
    const phase = await popup.locator('#status').getAttribute('data-phase');
    if (phase !== 'success') {
      throw new Error(`export failed: ${await popup.locator('#status').textContent()}`);
    }
    const out = join(SHOTS, '03-saved.png');
    await composite(background, await capturePopup(popup), out);
    report(out);
    await popup.close();
    await page.close();
  }

  // The promo artwork takes its name and pitch from the built locale file, so it
  // never drifts from the listing.
  const messages = JSON.parse(readFileSync(join(DIST, '_locales/en/messages.json'), 'utf8'));
  const icon = readFileSync(join(DIST, 'icons/icon-128.png')).toString('base64');
  const escape = (text) =>
    text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // 5. Small promo tile: icon, name and the one-line pitch.
  {
    const tile = await plain.newPage({ viewport: { width: 440, height: 280 }, deviceScaleFactor: 1 });
    await tile.setContent(`<!doctype html>
      <style>
        html, body { margin: 0; width: 440px; height: 280px; overflow: hidden; }
        body { display: flex; flex-direction: column; justify-content: center; gap: 14px; padding: 0 36px;
               box-sizing: border-box; background: linear-gradient(135deg, #f6f8fb, #e7ecf4);
               font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #1d2433; }
        .head { display: flex; align-items: center; gap: 16px; }
        img { width: 64px; height: 64px; }
        h1 { margin: 0; font-size: 34px; letter-spacing: -0.01em; }
        p { margin: 0; font-size: 17px; line-height: 1.4; color: #3d4658; }
      </style>
      <div class="head"><img src="data:image/png;base64,${icon}"><h1>${escape(messages.extName.message)}</h1></div>
      <p>${escape(messages.extDescription.message)}</p>`);
    await tile.waitForFunction(() => Array.from(document.images).every((img) => img.complete));
    await tile.screenshot({ path: PROMO });
    report(PROMO);
    await tile.close();
  }
  // 6. Marquee tile: the pitch on the left, the picker shot on the right — the
  //    feature that most sets this apart from Chrome's own Print dialog.
  {
    const picker = readFileSync(join(SHOTS, '02-picker.png')).toString('base64');
    const tile = await plain.newPage({ viewport: { width: 1400, height: 560 }, deviceScaleFactor: 1 });
    await tile.setContent(`<!doctype html>
      <style>
        html, body { margin: 0; width: 1400px; height: 560px; overflow: hidden; }
        body { position: relative; background: linear-gradient(135deg, #f6f8fb, #dfe6f1);
               font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #1d2433; }
        .copy { position: absolute; left: 80px; top: 0; bottom: 0; width: 470px;
                display: flex; flex-direction: column; justify-content: center; gap: 22px; }
        .head { display: flex; align-items: center; gap: 20px; }
        .head img { width: 84px; height: 84px; }
        h1 { margin: 0; font-size: 52px; letter-spacing: -0.02em; }
        p { margin: 0; font-size: 24px; line-height: 1.4; color: #3d4658; }
        ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 10px; font-size: 19px; color: #1d2433; }
        li::before { content: '✓'; color: #2563eb; font-weight: 700; margin-right: 10px; }
        .shot { position: absolute; left: 620px; top: 70px; width: 880px; border-radius: 14px;
                box-shadow: 0 24px 60px rgb(15 23 42 / 0.22), 0 0 0 1px rgb(15 23 42 / 0.08); }
      </style>
      <div class="copy">
        <div class="head"><img src="data:image/png;base64,${icon}"><h1>${escape(messages.extName.message)}</h1></div>
        <p>${escape(messages.extDescription.message)}</p>
        <ul><li>Whole page or just the parts you pick</li><li>Selectable text, not screenshots</li><li>No uploads, no account, no tracking</li></ul>
      </div>
      <img class="shot" src="data:image/png;base64,${picker}">`);
    await tile.waitForFunction(() => Array.from(document.images).every((img) => img.complete));
    await tile.screenshot({ path: MARQUEE });
    report(MARQUEE);
    await tile.close();
  }

  /**
   * The store wants 24-bit images with no alpha channel. Read straight from
   * each PNG's IHDR chunk: width and height at bytes 16–23, bit depth at 24,
   * colour type at 25 (2 = RGB; 6 = RGBA, which the store rejects).
   */
  const expected = [
    ...['01-popup', '02-picker', '03-saved', '04-options'].map((name) => [join(SHOTS, `${name}.png`), 1280, 800]),
    [PROMO, 440, 280],
    [MARQUEE, 1400, 560],
  ];
  for (const [path, width, height] of expected) {
    const png = readFileSync(path);
    const actual = { width: png.readUInt32BE(16), height: png.readUInt32BE(20), depth: png[24], colour: png[25] };
    if (actual.width !== width || actual.height !== height || actual.depth !== 8 || actual.colour !== 2) {
      throw new Error(
        `${relative(root, path)}: expected ${width}×${height} 8-bit RGB, got ` +
          `${actual.width}×${actual.height} ${actual.depth}-bit colour type ${actual.colour}`,
      );
    }
  }
  console.log('all images are 24-bit RGB with no alpha, at the sizes the store expects');
} finally {
  await context.close();
  await plain.close();
  await new Promise((done) => server.close(done));
  for (const dir of [userDataDir, downloadDir]) rmSync(dir, { recursive: true, force: true });
}
