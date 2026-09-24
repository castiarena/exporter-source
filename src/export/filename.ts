/**
 * Derives a filesystem-safe download name from a page title.
 *
 * This is a security boundary: the input is attacker-controlled (any page can
 * set any <title>) and the output is handed to chrome.downloads.download, which
 * interprets `/` as a directory separator. 01-requirements.md §4 requires that
 * path traversal and invalid characters cannot survive this function.
 */

/** Characters Windows/macOS/Linux reject, plus separators and control codes. */
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;
/** Zero-width, bidi-override and other invisible codepoints used to spoof names. */
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
/** Reserved device names on Windows, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const MAX_BASE_LENGTH = 100;
const FALLBACK_BASE = 'page';

/** Local-time YYYY-MM-DD; UTC would show the wrong day for evening exports. */
export function formatDateStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Reduces arbitrary text to a single safe path segment. Returns '' if nothing
 * usable survives, so callers can fall back rather than emit a bare extension.
 */
export function sanitizeSegment(input: string): string {
  let value = typeof input === 'string' ? input : '';

  // Normalize first: composed forms keep accented characters as single, valid
  // codepoints instead of a base letter plus a stray combining mark.
  try {
    value = value.normalize('NFC');
  } catch {
    /* Some exotic inputs throw on normalize; the raw value is still cleaned below. */
  }

  value = value
    .replace(INVISIBLE, '')
    .replace(ILLEGAL, ' ')
    // Collapse every kind of whitespace, including newlines from a multiline title.
    .replace(/\s+/g, ' ')
    // `..` cannot form a traversal segment once `/` and `\` are gone, but a
    // leading dot still makes a hidden file and trailing dots break Windows.
    .replace(/\.{2,}/g, '.')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');

  if (value.length > MAX_BASE_LENGTH) {
    value = value.slice(0, MAX_BASE_LENGTH).replace(/[.\s]+$/, '');
  }
  if (RESERVED.test(value)) {
    value = `${value}-page`;
  }
  return value;
}

/** Last-resort base derived from the URL when the title yields nothing. */
export function baseFromUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    return sanitizeSegment(new URL(url).hostname.replace(/^www\./, ''));
  } catch {
    return '';
  }
}

export interface FilenameInput {
  readonly title?: string;
  readonly url?: string;
  readonly extension?: string;
  readonly date?: Date;
}

/**
 * Builds the final `name-YYYY-MM-DD.pdf`. Guaranteed to be a single path
 * segment: no separators, no traversal, no leading dot, never empty.
 */
export function buildFilename({
  title,
  url,
  extension = 'pdf',
  date = new Date(),
}: FilenameInput): string {
  const base = sanitizeSegment(title ?? '') || baseFromUrl(url) || FALLBACK_BASE;
  const ext = sanitizeSegment(extension).toLowerCase().replace(/^\.+/, '') || 'pdf';
  return `${base}-${formatDateStamp(date)}.${ext}`;
}
