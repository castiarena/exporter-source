import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PAPER_SIZES } from '../../src/shared/constants';

/**
 * 01-requirements.md §3 requires every user-facing string to come from
 * _locales/ rather than being hardcoded. These tests are what keeps that true:
 * a key referenced from markup or from a constant but missing from the catalogue
 * would otherwise surface in the UI as its own raw key.
 */
const messages = JSON.parse(readFileSync('_locales/en/messages.json', 'utf8')) as Record<
  string,
  { message: string }
>;

const PAGES = ['src/popup/popup.html', 'src/options/options.html'];

function keysUsedIn(file: string): string[] {
  const html = readFileSync(file, 'utf8');
  return [...html.matchAll(/data-i18n(?:-label)?="([^"]+)"/g)].map((match) => match[1] as string);
}

describe('_locales/en/messages.json', () => {
  it('defines every key the popup and options markup references', () => {
    for (const page of PAGES) {
      for (const key of keysUsedIn(page)) {
        expect(messages[key], `${page} references missing message "${key}"`).toBeDefined();
      }
    }
  });

  it('defines a label for every paper size', () => {
    for (const size of PAPER_SIZES) {
      expect(messages[size.labelKey], `missing label for paper size ${size.id}`).toBeDefined();
    }
  });

  it('defines the manifest strings', () => {
    for (const key of ['extName', 'extDescription', 'popupHeading']) {
      expect(messages[key], `manifest.json references missing message "${key}"`).toBeDefined();
    }
  });

  it('has a non-empty message for every entry', () => {
    for (const [key, entry] of Object.entries(messages)) {
      expect(entry.message, `empty message for "${key}"`).toBeTruthy();
    }
  });
});
