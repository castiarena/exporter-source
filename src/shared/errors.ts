/**
 * Error classification. Everything that can go wrong is funnelled into an
 * ExportError carrying an ExportErrorCode, and each code has exactly one
 * plain-language string in _locales/en/messages.json.
 *
 * 01-requirements.md §2: failures must say *why*, never fail silently.
 */
import { RESTRICTED_HOSTS, RESTRICTED_SCHEMES } from './constants';
import type { ExportErrorCode } from './types';

export class ExportError extends Error {
  readonly code: ExportErrorCode;
  /** True when the CDP path failed in a way the canvas fallback can retry. */
  readonly recoverable: boolean;

  constructor(code: ExportErrorCode, options: { cause?: unknown; recoverable?: boolean } = {}) {
    super(`exporter:${code}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ExportError';
    this.code = code;
    this.recoverable = options.recoverable ?? false;
  }
}

/** i18n key for a code, e.g. RESTRICTED_PAGE -> errorRestrictedPage. */
export function messageKeyFor(code: ExportErrorCode): string {
  const camel = code
    .toLowerCase()
    .replace(/_(.)/g, (_match, char: string) => char.toUpperCase());
  return `error${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}

export function toExportError(cause: unknown): ExportError {
  if (cause instanceof ExportError) return cause;
  return classifyChromeError(cause instanceof Error ? cause.message : String(cause), cause);
}

/**
 * Maps the strings Chrome puts in `runtime.lastError` / thrown errors onto our
 * codes. Chrome does not give machine-readable error codes here, so matching on
 * message text is the only option; the patterns are deliberately loose and
 * anything unmatched degrades to UNKNOWN rather than being mislabelled.
 */
export function classifyChromeError(message: string, cause?: unknown): ExportError {
  const text = message.toLowerCase();
  const as = (code: ExportErrorCode, recoverable = false) =>
    new ExportError(code, { cause, recoverable });

  if (text.includes('another debugger') || text.includes('already attached')) {
    return as('DEBUGGER_IN_USE', true);
  }
  if (text.includes('devtools') && text.includes('open')) {
    return as('DEBUGGER_IN_USE', true);
  }
  if (
    text.includes('cannot access a chrome') ||
    text.includes('cannot access contents of') ||
    text.includes('extensions gallery') ||
    text.includes('chrome web store') ||
    text.includes('showing extension') ||
    text.includes('chrome:// url')
  ) {
    return as('RESTRICTED_PAGE');
  }
  if (text.includes('permission') || text.includes('not allowed')) {
    return as('PERMISSION_DENIED', true);
  }
  if (text.includes('no tab with id') || text.includes('no active tab')) {
    return as('NO_ACTIVE_TAB');
  }
  if (
    text.includes('cannot attach') ||
    text.includes('target closed') ||
    text.includes('detached') ||
    text.includes('debugger is not attached')
  ) {
    return as('PAGE_NOT_CAPTURABLE', true);
  }
  // Thrown by the content scripts when a picked element has gone from the DOM
  // between selection and render — a re-render, a route change, a dismissed
  // dialog. Recoverable is false: the canvas path would not find it either.
  if (text.includes('no longer on the page')) {
    return as('ELEMENT_GONE');
  }
  if (text.includes('timed out') || text.includes('timeout')) {
    return as('RENDER_FAILED', true);
  }
  if (text.includes('receiving end does not exist') || text.includes('could not establish connection')) {
    return as('PAGE_NOT_CAPTURABLE', true);
  }
  return as('UNKNOWN', true);
}

/**
 * Pre-flight check, run before any injection or debugger attach so the user
 * gets the specific "this page can't be exported" message immediately instead
 * of a Chrome API failure a second later.
 */
export function restrictionFor(url: string | undefined): ExportErrorCode | null {
  if (!url) return 'NO_ACTIVE_TAB';

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'RESTRICTED_PAGE';
  }

  if ((RESTRICTED_SCHEMES as readonly string[]).includes(parsed.protocol)) {
    return 'RESTRICTED_PAGE';
  }
  const host = parsed.hostname.toLowerCase();
  if (
    (RESTRICTED_HOSTS as readonly string[]).some(
      (blocked) => host === blocked || host.endsWith(`.${blocked}`),
    )
  ) {
    return 'RESTRICTED_PAGE';
  }
  // Chrome's own PDF viewer runs in a plugin frame the extension cannot read.
  if (parsed.pathname.toLowerCase().endsWith('.pdf')) {
    return 'PAGE_NOT_CAPTURABLE';
  }
  return null;
}
