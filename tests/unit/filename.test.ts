import { describe, expect, it } from 'vitest';

import { baseFromUrl, buildFilename, formatDateStamp, sanitizeSegment } from '../../src/export/filename';

const DATE = new Date(2026, 8, 9); // 9 September 2026, local time

describe('sanitizeSegment', () => {
  it('keeps ordinary titles readable', () => {
    expect(sanitizeSegment('Quarterly Report 2026')).toBe('Quarterly Report 2026');
  });

  it('strips path separators so a title cannot become a directory', () => {
    expect(sanitizeSegment('reports/2026/q3')).toBe('reports 2026 q3');
    expect(sanitizeSegment('reports\\2026\\q3')).toBe('reports 2026 q3');
  });

  it('defuses traversal attempts', () => {
    expect(sanitizeSegment('../../../etc/passwd')).toBe('etc passwd');
    expect(sanitizeSegment('..\\..\\windows\\system32')).toBe('windows system32');
    expect(sanitizeSegment('....//....//secret')).toBe('secret');
  });

  it('removes characters filesystems reject', () => {
    expect(sanitizeSegment('a:b*c?d"e<f>g|h')).toBe('a b c d e f g h');
  });

  it('removes control characters, including newlines and NULs', () => {
    expect(sanitizeSegment('line one\nline two\ttabbed')).toBe('line one line two tabbed');
    expect(sanitizeSegment('null\u0000byte')).toBe('null byte');
  });

  it('removes invisible and bidi-override characters used to spoof names', () => {
    expect(sanitizeSegment('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(sanitizeSegment('a\u200bb\ufeffc')).toBe('abc');
  });

  it('never produces a leading dot, which would make a hidden file', () => {
    expect(sanitizeSegment('.hidden')).toBe('hidden');
    expect(sanitizeSegment('...')).toBe('');
  });

  it('never produces a trailing dot or space, which Windows rejects', () => {
    expect(sanitizeSegment('trailing.')).toBe('trailing');
    expect(sanitizeSegment('trailing   ')).toBe('trailing');
  });

  it('caps very long titles', () => {
    const result = sanitizeSegment('x'.repeat(5000));
    expect(result).toHaveLength(100);
  });

  it('does not leave a dangling dot after capping', () => {
    const result = sanitizeSegment(`${'x'.repeat(99)}.tail`);
    expect(result.endsWith('.')).toBe(false);
  });

  it('preserves unicode and emoji', () => {
    expect(sanitizeSegment('Éxito café 日本語')).toBe('Éxito café 日本語');
    expect(sanitizeSegment('Ship it 🚀 today')).toBe('Ship it 🚀 today');
  });

  it('normalizes decomposed characters to their composed form', () => {
    expect(sanitizeSegment('cafe\u0301')).toBe('caf\u00e9');
  });

  it('renames Windows reserved device names', () => {
    expect(sanitizeSegment('CON')).toBe('CON-page');
    expect(sanitizeSegment('nul.txt')).toBe('nul.txt-page');
    expect(sanitizeSegment('COM1')).toBe('COM1-page');
    expect(sanitizeSegment('console')).toBe('console');
  });

  it('returns empty for input with nothing usable', () => {
    expect(sanitizeSegment('')).toBe('');
    expect(sanitizeSegment('   ')).toBe('');
    expect(sanitizeSegment('/////')).toBe('');
  });

  it('tolerates non-string input', () => {
    expect(sanitizeSegment(undefined as unknown as string)).toBe('');
    expect(sanitizeSegment(null as unknown as string)).toBe('');
  });
});

describe('baseFromUrl', () => {
  it('uses the hostname without a www prefix', () => {
    expect(baseFromUrl('https://www.example.com/a/b?c=d')).toBe('example.com');
  });

  it('returns empty for unusable input', () => {
    expect(baseFromUrl(undefined)).toBe('');
    expect(baseFromUrl('not a url')).toBe('');
  });
});

describe('formatDateStamp', () => {
  it('zero-pads month and day', () => {
    expect(formatDateStamp(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('buildFilename', () => {
  it('combines a sanitized title with the date', () => {
    expect(buildFilename({ title: 'Quarterly Report', date: DATE })).toBe(
      'Quarterly Report-2026-09-09.pdf',
    );
  });

  it('falls back to the hostname when the title is unusable', () => {
    expect(buildFilename({ title: '   ', url: 'https://example.com/x', date: DATE })).toBe(
      'example.com-2026-09-09.pdf',
    );
  });

  it('falls back to a fixed name when nothing usable is available', () => {
    expect(buildFilename({ date: DATE })).toBe('page-2026-09-09.pdf');
  });

  it('always produces exactly one path segment', () => {
    const hostile = [
      '../../../etc/passwd',
      '/absolute/path',
      'C:\\Windows\\System32',
      '..',
      '.',
      'a/b\\c',
    ];
    for (const title of hostile) {
      const result = buildFilename({ title, url: 'https://example.com', date: DATE });
      expect(result).not.toContain('/');
      expect(result).not.toContain('\\');
      expect(result.startsWith('.')).toBe(false);
      expect(result.split('/')).toHaveLength(1);
    }
  });

  it('sanitizes the extension too', () => {
    expect(buildFilename({ title: 'x', extension: '../pdf', date: DATE })).toBe('x-2026-09-09.pdf');
  });
});
