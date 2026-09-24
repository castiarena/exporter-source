import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  ExportError,
  classifyChromeError,
  messageKeyFor,
  restrictionFor,
  toExportError,
} from '../../src/shared/errors';
import { EXPORT_ERROR_CODES } from '../../src/shared/types';

const messages = JSON.parse(readFileSync('_locales/en/messages.json', 'utf8')) as Record<
  string,
  { message: string }
>;

describe('messageKeyFor', () => {
  it('converts a code to its camelCase i18n key', () => {
    expect(messageKeyFor('RESTRICTED_PAGE')).toBe('errorRestrictedPage');
    expect(messageKeyFor('UNKNOWN')).toBe('errorUnknown');
    expect(messageKeyFor('PAGE_NOT_CAPTURABLE')).toBe('errorPageNotCapturable');
  });

  it('has a real localized string behind every error code', () => {
    // 01-requirements.md §2: failures must say why, in plain language. A code
    // with no string would surface as a raw key in the popup.
    for (const code of EXPORT_ERROR_CODES) {
      const key = messageKeyFor(code);
      expect(messages[key], `missing _locales/en/messages.json entry: ${key}`).toBeDefined();
      expect(messages[key]?.message.length).toBeGreaterThan(10);
    }
  });
});

describe('classifyChromeError', () => {
  const cases: Array<[string, string]> = [
    ['Another debugger is already attached to the tab with id: 5', 'DEBUGGER_IN_USE'],
    ['Cannot access a chrome:// URL', 'RESTRICTED_PAGE'],
    ['Cannot access contents of the page', 'RESTRICTED_PAGE'],
    ['The extensions gallery cannot be scripted', 'RESTRICTED_PAGE'],
    ['Cannot attach to this target', 'PAGE_NOT_CAPTURABLE'],
    ['Detached while handling command', 'PAGE_NOT_CAPTURABLE'],
    ['No tab with id: 42', 'NO_ACTIVE_TAB'],
    ['Page.printToPDF timed out after 60000ms', 'RENDER_FAILED'],
    ['Could not establish connection. Receiving end does not exist.', 'PAGE_NOT_CAPTURABLE'],
    ['This operation is not allowed', 'PERMISSION_DENIED'],
  ];

  for (const [message, expected] of cases) {
    it(`maps "${message.slice(0, 40)}" to ${expected}`, () => {
      expect(classifyChromeError(message).code).toBe(expected);
    });
  }

  it('degrades to UNKNOWN rather than mislabelling', () => {
    expect(classifyChromeError('something entirely new went wrong').code).toBe('UNKNOWN');
  });

  it('marks failures the canvas fallback can retry as recoverable', () => {
    expect(classifyChromeError('Another debugger is already attached').recoverable).toBe(true);
    expect(classifyChromeError('Cannot attach to this target').recoverable).toBe(true);
    // A page Chrome forbids reading cannot be rendered by any path.
    expect(classifyChromeError('Cannot access a chrome:// URL').recoverable).toBe(false);
  });
});

describe('toExportError', () => {
  it('passes an ExportError through unchanged', () => {
    const original = new ExportError('TOO_LARGE');
    expect(toExportError(original)).toBe(original);
  });

  it('classifies a plain Error', () => {
    expect(toExportError(new Error('No tab with id: 1')).code).toBe('NO_ACTIVE_TAB');
  });

  it('classifies a non-Error throw', () => {
    expect(toExportError('Cannot access a chrome:// URL').code).toBe('RESTRICTED_PAGE');
  });
});

describe('restrictionFor', () => {
  it('allows ordinary web pages', () => {
    expect(restrictionFor('https://example.com/article')).toBeNull();
    expect(restrictionFor('http://localhost:3000/')).toBeNull();
  });

  it('rejects browser-internal pages', () => {
    for (const url of [
      'chrome://extensions',
      'chrome-extension://abcdef/popup.html',
      'devtools://devtools/bundled/inspector.html',
      'edge://settings',
      'about:blank',
      'view-source:https://example.com',
    ]) {
      expect(restrictionFor(url), url).toBe('RESTRICTED_PAGE');
    }
  });

  it('allows local files, which are exportable once file access is granted', () => {
    // Blocking file:// outright would be wrong: Chrome lets an extension read
    // local pages when the user turns on "Allow access to file URLs". If they
    // have not, injection fails and the FILE_ACCESS_DENIED message says so.
    expect(restrictionFor('file:///Users/someone/notes.html')).toBeNull();
  });

  it('rejects the Chrome Web Store, which blocks all extensions by policy', () => {
    expect(restrictionFor('https://chromewebstore.google.com/detail/x')).toBe('RESTRICTED_PAGE');
    expect(restrictionFor('https://chrome.google.com/webstore')).toBe('RESTRICTED_PAGE');
  });

  it('does not reject a lookalike hostname', () => {
    expect(restrictionFor('https://chromewebstore.google.com.evil.test/')).toBeNull();
  });

  it("rejects a PDF already open in Chrome's viewer", () => {
    expect(restrictionFor('https://example.com/paper.pdf')).toBe('PAGE_NOT_CAPTURABLE');
  });

  it('reports a missing or unparseable URL specifically', () => {
    expect(restrictionFor(undefined)).toBe('NO_ACTIVE_TAB');
    expect(restrictionFor('')).toBe('NO_ACTIVE_TAB');
    expect(restrictionFor('not a url')).toBe('RESTRICTED_PAGE');
  });
});
