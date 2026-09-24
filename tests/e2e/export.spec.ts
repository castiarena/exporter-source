/**
 * End-to-end coverage for both export scopes, driving a real Chromium with the
 * built extension loaded unpacked.
 *
 * Runs against dist-test/, not dist/ — Playwright cannot click a real toolbar
 * icon, and activeTab is granted only by that click, so the test build adds a
 * host permission in its place (see scripts/build.mjs). Everything else about
 * the two builds is identical.
 *
 * The popup is opened in its own browser window rather than as a tab, so that
 * the fixture stays the active tab of the normal window — which is what the
 * service worker resolves as the export target, exactly as it would behind a
 * real toolbar popup.
 *
 * Prerequisites:  npm run build:test  &&  npx playwright install chromium
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, expect, test } from '@playwright/test';
import type { BrowserContext, Page, Worker } from '@playwright/test';

const DIST = resolve('dist-test');

let context: BrowserContext;
let extensionId: string;
let userDataDir: string;
let downloadDir: string;
let server: Server;
let FIXTURE: string;
let DASHBOARD: string;

/**
 * The fixture is served over HTTP rather than opened from file://, because
 * reading local files needs a per-extension toggle a user sets by hand and no
 * command-line flag can grant.
 */
function startFixtureServer(): Promise<string> {
  const pages: Record<string, Buffer> = {
    '/article.html': readFileSync(resolve('tests/fixtures/article.html')),
    '/dashboard.html': readFileSync(resolve('tests/fixtures/dashboard.html')),
  };
  server = createServer((request, response) => {
    const body = pages[(request.url ?? '').split('?')[0] as string];
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      DASHBOARD = `http://127.0.0.1:${port}/dashboard.html`;
      done(`http://127.0.0.1:${port}/article.html`);
    });
  });
}

test.beforeAll(async () => {
  if (!existsSync(DIST)) {
    throw new Error('dist-test/ not found — run `npm run build:test` first');
  }

  FIXTURE = await startFixtureServer();
  userDataDir = mkdtempSync(join(tmpdir(), 'exporter-e2e-'));
  downloadDir = mkdtempSync(join(tmpdir(), 'exporter-dl-'));

  context = await chromium.launchPersistentContext(userDataDir, {
    // The full Chromium build, not the headless shell Playwright installs
    // alongside it — the shell has no extension support at all.
    channel: 'chromium',
    headless: true,
    downloadsPath: downloadDir,
    acceptDownloads: true,
    args: [
      // Extensions load only under the newer headless mode.
      '--headless=new',
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
    ],
  });

  const started = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(started.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  await new Promise((done) => server?.close(done));
  for (const dir of [userDataDir, downloadDir]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The extension's service worker, re-acquired on every use.
 *
 * An MV3 worker is stopped and restarted freely, so a handle captured once goes
 * stale; and a worker that has just started may not have its chrome.* APIs
 * bound yet. Both show up as intermittent "cannot read properties of undefined"
 * failures, so this waits for a live one.
 */
async function sw(): Promise<Worker> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const candidate = context.serviceWorkers()[0];
    if (candidate) {
      try {
        const ready = await candidate.evaluate(
          () => typeof chrome?.windows?.create === 'function' && typeof chrome?.tabs?.query === 'function',
        );
        if (ready) return candidate;
      } catch (cause) {
        lastError = cause;
      }
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`the extension service worker never became ready: ${String(lastError)}`);
}

/** Opens the extension popup in its own window, the way the toolbar would. */
async function openPopup(): Promise<Page> {
  const url = `chrome-extension://${extensionId}/popup/popup.html`;
  const worker = await sw();
  const appearing = context.waitForEvent('page');
  await worker.evaluate(
    (popupUrl) => chrome.windows.create({ url: popupUrl, type: 'popup', width: 360, height: 460 }),
    url,
  );
  const popup = await appearing;
  await popup.waitForLoadState();
  await expect(popup.locator('#export-page')).toBeEnabled();
  return popup;
}

async function openFixture(url = FIXTURE): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url);
  await page.bringToFront();
  return page;
}

/**
 * Waits for the export to settle and returns what the extension reported.
 *
 * The download is started by the service worker, not by the page, so Playwright's
 * per-page `download` event is not the right signal here. chrome.downloads is,
 * and it also hands back the real path on disk.
 */
async function awaitExport(popup: Page): Promise<{ phase: string; message: string }> {
  const status = popup.locator('#status');
  await expect(status).toHaveAttribute('data-phase', /success|error/, { timeout: 45_000 });
  return {
    phase: (await status.getAttribute('data-phase')) ?? '',
    message: (await status.textContent()) ?? '',
  };
}

/**
 * Counts pages by reading the page tree straight out of the PDF.
 *
 * Both producers here leave that structure uncompressed — Chrome's printToPDF
 * emits no object streams, and jsPDF compresses content, not the catalogue — so
 * counting `/Type /Page` (never `/Pages`) is reliable for these files. It is a
 * test-only shortcut, not a general PDF parser.
 */
export function pdfPageCount(contents: Buffer): number {
  return (contents.toString('latin1').match(/\/Type\s*\/Page(?![s])/g) ?? []).length;
}

/** The file Chrome most recently wrote: is it a PDF, how big, how many pages. */
async function lastDownload(): Promise<{ isPdf: boolean; bytes: number; pages: number }> {
  const items = await (await sw()).evaluate(() =>
    chrome.downloads.search({ limit: 1, orderBy: ['-startTime'] }),
  );
  const item = items[0];
  expect(item, 'the extension started no download').toBeDefined();
  expect(item?.state).toBe('complete');
  const contents = readFileSync(item?.filename as string);
  return {
    isPdf: contents.subarray(0, 5).toString('latin1') === '%PDF-',
    bytes: contents.length,
    pages: pdfPageCount(contents),
  };
}

/** Runs the picker, clicking each selector in turn, then exports with Enter. */
async function pickAndExport(page: Page, popup: Page, selectors: string[]): Promise<void> {
  await popup.click('#export-element');
  await page.waitForFunction(() => document.getElementById('exporter-picker-host') !== null, {
    timeout: 10_000,
  });
  for (const selector of selectors) await page.click(selector);
  await page.keyboard.press('Enter');
}

/** Marker attributes and overlay nodes the picker and isolation pass leave. */
const residueOf = (page: Page) =>
  page.evaluate(() => ({
    selected: document.querySelectorAll('[data-exporter-selected]').length,
    hidden: document.querySelectorAll('[data-exporter-hidden]').length,
    ancestors: document.querySelectorAll('[data-exporter-ancestor]').length,
    breaks: document.querySelectorAll('[data-exporter-break]').length,
    overlays: document.querySelectorAll('#exporter-picker-host').length,
    styles: document.querySelectorAll('#exporter-isolate-style, #exporter-strip-print-style').length,
  }));

const NO_RESIDUE = { selected: 0, hidden: 0, ancestors: 0, breaks: 0, overlays: 0, styles: 0 };

test('the popup opens with its controls localized, labelled and enabled', async () => {
  const popup = await openPopup();

  await expect(popup.locator('h1')).toHaveText('Export to PDF');
  await expect(popup.locator('#export-page')).toHaveText('Export page to PDF');
  await expect(popup.locator('#paper-size option')).toHaveCount(5);
  // What a screen reader announces as the export progresses.
  await expect(popup.locator('#status')).toHaveAttribute('aria-live', 'polite');
  // Every control reachable by keyboard alone.
  await popup.keyboard.press('Tab');
  await expect(popup.locator('#export-page')).toBeFocused();

  await popup.close();
});

test('exports the full page to a PDF named after the title and date', async () => {
  const page = await openFixture();
  const popup = await openPopup();

  await popup.click('#export-page');
  const result = await awaitExport(popup);

  expect(result.phase, result.message).toBe('success');
  expect(result.message).toMatch(/^Saved Fixture Article — exporter e2e-\d{4}-\d{2}-\d{2}\.pdf\.$/);

  const file = await lastDownload();
  expect(file.isPdf).toBe(true);
  // A blank PDF of the same page would be a fraction of this.
  expect(file.bytes).toBeGreaterThan(1000);

  await popup.close();
  await page.close();
});

test('exports one picked element to a single page, leaving the page as it was', async () => {
  const page = await openFixture();
  const popup = await openPopup();

  await pickAndExport(page, popup, ['#target']);

  const result = await awaitExport(popup);
  expect(result.phase, result.message).toBe('success');

  const file = await lastDownload();
  expect(file.isPdf).toBe(true);
  // The card is small; isolating it must not carry the rest of the article along.
  expect(file.pages).toBe(1);

  expect(await residueOf(page)).toEqual(NO_RESIDUE);

  await popup.close();
  await page.close();
});

test('exports several picked elements, one page each, in document order', async () => {
  const page = await openFixture();
  const popup = await openPopup();

  // Clicked bottom-up on purpose: the pages must come out in document order,
  // not click order.
  await pickAndExport(page, popup, ['#target-2', '#target']);

  const result = await awaitExport(popup);
  expect(result.phase, result.message).toBe('success');
  expect(result.message).toContain('2 elements');

  const file = await lastDownload();
  expect(file.isPdf).toBe(true);
  expect(file.pages).toBe(2);

  expect(await residueOf(page)).toEqual(NO_RESIDUE);

  await popup.close();
  await page.close();
});

test('clicking a pick a second time removes it from the selection', async () => {
  const page = await openFixture();
  const popup = await openPopup();

  await popup.click('#export-element');
  await page.waitForFunction(() => document.getElementById('exporter-picker-host') !== null);

  await page.click('#target');
  await page.click('#target-2');
  expect(await page.evaluate(() => document.querySelectorAll('[data-exporter-selected]').length)).toBe(2);

  await page.click('#target-2');
  expect(await page.evaluate(() => document.querySelectorAll('[data-exporter-selected]').length)).toBe(1);

  await page.keyboard.press('Enter');
  const result = await awaitExport(popup);
  expect(result.phase, result.message).toBe('success');
  expect((await lastDownload()).pages).toBe(1);

  await popup.close();
  await page.close();
});

test('picking a container replaces the picks it would otherwise duplicate', async () => {
  const page = await openFixture();
  const popup = await openPopup();

  await popup.click('#export-element');
  await page.waitForFunction(() => document.getElementById('exporter-picker-host') !== null);

  // The heading inside the card, then the card itself: the card contains the
  // heading, so keeping both would put the same content in the PDF twice.
  await page.click('#target h2');
  await page.click('#target p');
  expect(await page.evaluate(() => document.querySelectorAll('[data-exporter-selected]').length)).toBe(2);

  await page.click('#target');
  const remaining = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-exporter-selected]')).map((node) => node.id),
  );
  expect(remaining).toEqual(['target']);

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('exporter-picker-host') === null);

  await popup.close();
  await page.close();
});

test('Esc cancels the picker, discarding whatever was already picked', async () => {
  const page = await openFixture();
  const popup = await openPopup();

  await popup.click('#export-element');
  await page.waitForFunction(() => document.getElementById('exporter-picker-host') !== null);
  await page.click('#target');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('exporter-picker-host') === null);
  expect(await residueOf(page)).toEqual(NO_RESIDUE);

  const result = await awaitExport(popup);
  expect(result.phase).toBe('error');
  expect(result.message).toBe('Selection cancelled.');

  await popup.close();
  await page.close();
});

test('reports a specific reason on a page Chrome will not let it read', async () => {
  const page = await openFixture('chrome://version');
  const popup = await openPopup();

  await popup.click('#export-page');

  const result = await awaitExport(popup);
  expect(result.phase).toBe('error');
  expect(result.message).toContain('Chrome does not allow extensions to read this page');

  await popup.close();
  await page.close();
});

test('the canvas fallback renderer produces a PDF without the debugger', async () => {
  // The fallback only runs when chrome.debugger is unavailable, which cannot be
  // simulated from outside the worker. Driving its content script directly is
  // the next best thing: it proves the vendored html2canvas + jsPDF pipeline
  // renders and paginates in a real page.
  const page = await openFixture();
  const worker = await sw();
  const tabId = await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return tab?.id;
  }, FIXTURE);
  expect(tabId).toBeDefined();

  const base64 = await worker.evaluate(async (id) => {
    await chrome.scripting.executeScript({
      target: { tabId: id as number },
      files: ['content/pdf-via-canvas.js'],
    });
    const response = (await chrome.tabs.sendMessage(id as number, {
      type: 'RENDER_CANVAS_PDF',
      options: {
        format: 'pdf',
        paperSize: 'a4',
        printBackground: true,
        usePagePrintStyles: false,
      },
      selector: null,
    })) as { ok: boolean; value?: { base64: string }; error?: string };
    if (!response.ok) throw new Error(response.error);
    return response.value?.base64 as string;
  }, tabId);

  // "JVBERi0" is base64 for "%PDF-".
  expect(base64.startsWith('JVBERi0')).toBe(true);
  expect(base64.length).toBeGreaterThan(5000);

  await page.close();
});

test('the canvas fallback also gives each selected element its own page', async () => {
  const page = await openFixture();
  const worker = await sw();
  const tabId = await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return tab?.id;
  }, FIXTURE);

  const base64 = await worker.evaluate(async (id) => {
    // Mark both cards the way the picker would, then render without the
    // debugger — the fallback scopes itself by rendering each element, so it
    // must reach the same page count as the CDP path.
    await chrome.scripting.executeScript({
      target: { tabId: id as number },
      func: () => {
        for (const selector of ['#target', '#target-2']) {
          document.querySelector(selector)?.setAttribute('data-exporter-selected', '');
        }
      },
    });
    await chrome.scripting.executeScript({
      target: { tabId: id as number },
      files: ['content/pdf-via-canvas.js'],
    });
    const response = (await chrome.tabs.sendMessage(id as number, {
      type: 'RENDER_CANVAS_PDF',
      options: {
        format: 'pdf',
        paperSize: 'a4',
        printBackground: true,
        usePagePrintStyles: false,
      },
      selector: '[data-exporter-selected]',
    })) as { ok: boolean; value?: { base64: string }; error?: string };
    if (!response.ok) throw new Error(response.error);
    return response.value?.base64 as string;
  }, tabId);

  expect(pdfPageCount(Buffer.from(base64, 'base64'))).toBe(2);

  await page.close();
});

/*
 * Page-count regression suite.
 *
 * A real site produced four pages from two picked elements. tests/fixtures/
 * dashboard.html reproduces why: full-height section wrappers, a decorative
 * ::after, margins on the elements themselves and a multi-column ancestor. Each
 * reserves space that a forced page break then strands on a page of its own, or
 * swallows the break outright.
 *
 * The rule these tests hold the exporter to is exact and easy to state: one
 * picked element, one page — for as long as each element fits on a page.
 */
test.describe('a picked element never brings a blank page with it', () => {
  /**
   * Hazard profiles, applied one at a time as a class on <body>.
   *
   * They are kept apart because they mask each other: a multi-column ancestor
   * halves the page height, which hides the blank page a full-height wrapper
   * would otherwise strand. Combined into one layout, the fixture passed even
   * with the isolation fix reverted — which is precisely the kind of test that
   * looks like coverage and provides none.
   */
  const HAZARDS = [
    { name: 'a plain layout', cls: '' },
    { name: 'full-height wrappers, a decorative ::after and element margins', cls: 'hz-spacing' },
    { name: 'a multi-column ancestor', cls: 'hz-columns' },
    { name: 'an inline-level element', cls: 'hz-inline' },
    { name: 'an absolutely positioned element', cls: 'hz-absolute' },
    // One deliberate combination: hazards that individually break pagination
    // must not start passing because they happen to cancel out.
    { name: 'spacing and columns together', cls: 'hz-spacing hz-columns' },
  ];

  for (const hazard of HAZARDS) {
    for (const picks of [
      ['#card-one'],
      ['#card-one', '#card-two'],
      ['#card-one', '#card-two', '#card-three'],
    ]) {
      test(`${picks.length} element(s) -> ${picks.length} page(s) with ${hazard.name}`, async () => {
        const page = await openFixture(DASHBOARD);
        if (hazard.cls) {
          await page.evaluate(
            (cls) => document.body.classList.add(...cls.split(' ')),
            hazard.cls,
          );
        }
        const popup = await openPopup();

        await popup.click('#export-element');
        await page.waitForFunction(() => document.getElementById('exporter-picker-host') !== null, {
          timeout: 10_000,
        });
        for (const selector of picks) {
          // The cards sit a screenful apart, so each has to be scrolled to.
          await page.locator(selector).scrollIntoViewIfNeeded();
          await page.click(selector);
        }
        await page.keyboard.press('Enter');

        const result = await awaitExport(popup);
        expect(result.phase, result.message).toBe('success');

        const file = await lastDownload();
        expect(file.isPdf).toBe(true);
        expect(file.pages).toBe(picks.length);

        expect(await residueOf(page)).toEqual(NO_RESIDUE);

        await popup.close();
        await page.close();
      });
    }
  }

  test('the canvas fallback agrees on the page count', async () => {
    const page = await openFixture(DASHBOARD);
    const worker = await sw();
    const tabId = await worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      return tab?.id;
    }, DASHBOARD);

    const base64 = await worker.evaluate(async (id) => {
      await chrome.scripting.executeScript({
        target: { tabId: id as number },
        func: () => {
          for (const selector of ['#card-one', '#card-two']) {
            document.querySelector(selector)?.setAttribute('data-exporter-selected', '');
          }
        },
      });
      await chrome.scripting.executeScript({
        target: { tabId: id as number },
        files: ['content/pdf-via-canvas.js'],
      });
      const response = (await chrome.tabs.sendMessage(id as number, {
        type: 'RENDER_CANVAS_PDF',
        options: { format: 'pdf', paperSize: 'a4', printBackground: true, usePagePrintStyles: false },
        selector: '[data-exporter-selected]',
      })) as { ok: boolean; value?: { base64: string }; error?: string };
      if (!response.ok) throw new Error(response.error);
      return response.value?.base64 as string;
    }, tabId);

    expect(pdfPageCount(Buffer.from(base64, 'base64'))).toBe(2);

    await page.close();
  });

  test('nothing outside the selection reaches the file', async () => {
    // Hidden siblings are the other half of isolation: a blank page is one
    // failure mode, the site navigation showing up in the PDF is the other.
    const page = await openFixture(DASHBOARD);
    const popup = await openPopup();

    await popup.click('#export-element');
    await page.waitForFunction(() => document.getElementById('exporter-picker-host') !== null);
    await page.locator('#card-one').scrollIntoViewIfNeeded();
    await page.click('#card-one');

    const isolated = await page.evaluate(() => {
      const visible = (selector: string) => {
        const node = document.querySelector(selector);
        return node ? getComputedStyle(node).display !== 'none' : false;
      };
      return { header: visible('.site-header'), sidebar: visible('.sidebar'), footer: visible('.site-footer') };
    });
    // Still on screen while picking — isolation happens at render time.
    expect(isolated).toEqual({ header: true, sidebar: true, footer: true });

    await page.keyboard.press('Enter');
    expect((await awaitExport(popup)).phase).toBe('success');

    const item = await (await sw()).evaluate(() =>
      chrome.downloads.search({ limit: 1, orderBy: ['-startTime'] }),
    );
    const text = readFileSync(item[0]?.filename as string).toString('latin1');
    // Chrome subsets fonts, so the PDF holds no readable words to grep for —
    // page count is the reliable signal that the rest of the site was excluded.
    expect(pdfPageCount(Buffer.from(text, 'latin1'))).toBe(1);

    await popup.close();
    await page.close();
  });
});
