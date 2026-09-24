import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { NAMED_ORDINAL_LIMIT, ordinalMessage } from '../../src/shared/ordinals';

const messages = JSON.parse(readFileSync('_locales/en/messages.json', 'utf8')) as Record<
  string,
  { message: string }
>;

describe('ordinalMessage', () => {
  it('names the first position', () => {
    expect(ordinalMessage(0)).toEqual({ key: 'ordinal1' });
  });

  it('names every position up to the limit', () => {
    for (let index = 0; index < NAMED_ORDINAL_LIMIT; index += 1) {
      expect(ordinalMessage(index)).toEqual({ key: `ordinal${index + 1}` });
    }
  });

  it('falls back to a number once a name stops helping', () => {
    expect(ordinalMessage(NAMED_ORDINAL_LIMIT)).toEqual({
      key: 'ordinalNumbered',
      substitutions: ['11'],
    });
    expect(ordinalMessage(28)).toEqual({ key: 'ordinalNumbered', substitutions: ['29'] });
  });

  it('treats a nonsensical index as the first position rather than showing a raw key', () => {
    expect(ordinalMessage(-1)).toEqual({ key: 'ordinal1' });
    expect(ordinalMessage(-100)).toEqual({ key: 'ordinal1' });
  });

  it('ignores a fractional index', () => {
    expect(ordinalMessage(2.7)).toEqual({ key: 'ordinal3' });
  });
});

describe('the names themselves', () => {
  it('has a localized name for every position the picker can label', () => {
    // A missing entry would put a raw key like "ordinal7" on the page.
    for (let index = 0; index < NAMED_ORDINAL_LIMIT; index += 1) {
      const { key } = ordinalMessage(index);
      expect(messages[key], `missing _locales entry: ${key}`).toBeDefined();
    }
    expect(messages.ordinalNumbered).toBeDefined();
    expect(messages.pickerSelectionFull).toBeDefined();
  });

  it('keeps every name short enough for a small on-page label', () => {
    for (let index = 0; index < NAMED_ORDINAL_LIMIT; index += 1) {
      const { key } = ordinalMessage(index);
      expect(messages[key]?.message.length ?? 99).toBeLessThanOrEqual(12);
    }
  });

  it('carries no markup or tag-shaped text, which is what these replaced', () => {
    for (let index = 0; index < NAMED_ORDINAL_LIMIT; index += 1) {
      const { key } = ordinalMessage(index);
      expect(messages[key]?.message).toMatch(/^[\p{L}\p{N} .'-]+$/u);
    }
  });
});
