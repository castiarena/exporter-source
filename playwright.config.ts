import { defineConfig } from '@playwright/test';

/**
 * e2e runs against a real Chromium with dist/ loaded unpacked — an extension's
 * service worker, chrome.debugger and chrome.downloads have no meaningful
 * stand-in, so there is nothing to gain from mocking them.
 *
 * Requires `npm run build` first, plus `npx playwright install chromium`.
 * Not part of `npm test` or CI: see README.md.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  // A persistent context can host only one extension at a time.
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
