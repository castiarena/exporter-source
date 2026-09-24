/**
 * Shared type vocabulary for the whole extension.
 *
 * The only runtime value here is EXPORT_ERROR_CODES, which exists so the codes
 * can be enumerated at runtime — the test suite walks it to prove every code has
 * a user-facing string in _locales/en/messages.json.
 */

/** Paper sizes offered in the UI. `auto` fits the page's own content width. */
export type PaperSizeId = 'a4' | 'letter' | 'legal' | 'tabloid' | 'auto';

export interface PaperSize {
  readonly id: PaperSizeId;
  /** Key into _locales/en/messages.json — never a hardcoded label. */
  readonly labelKey: string;
  /** Inches. `null` for `auto`, where the size is derived from the page itself. */
  readonly widthIn: number | null;
  readonly heightIn: number | null;
}

/**
 * v1 ships PDF only. The type exists so the roadmap's JPG/PNG formats
 * (04-roadmap.md) slot in without reworking the messaging contract.
 */
export type ExportFormat = 'pdf';

export interface ExportOptions {
  readonly format: ExportFormat;
  readonly paperSize: PaperSizeId;
  /** CDP `printBackground` / html2canvas background handling. */
  readonly printBackground: boolean;
  /**
   * When true the page's own `@page`/print stylesheet wins (CDP
   * `preferCSSPageSize`). When false those rules are stripped and the chosen
   * paper size is used instead.
   */
  readonly usePagePrintStyles: boolean;
}

/**
 * What is being exported: the whole document, or the elements the user picked.
 *
 * An element export can hold several elements. They are exported in document
 * order, and each one starts a new page.
 */
export type ExportScope =
  | { readonly kind: 'page' }
  | {
      readonly kind: 'element';
      /** Attribute selector matching every element the picker stamped. */
      readonly selector: string;
      readonly rects: readonly ElementRect[];
    };

export interface ElementRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Which rendering engine produced (or is producing) the file. */
export type ExportEngine = 'cdp' | 'canvas';

export type ExportPhase =
  | 'idle'
  | 'preparing'
  | 'picking'
  | 'rendering'
  | 'saving'
  | 'success'
  | 'error';

/**
 * Every failure the user can see. Each maps to a specific, human-readable
 * string in _locales/en/messages.json — 01-requirements.md §2 forbids silent
 * or generic failures.
 */
export const EXPORT_ERROR_CODES = [
  'RESTRICTED_PAGE',
  'NO_ACTIVE_TAB',
  'DEBUGGER_UNAVAILABLE',
  'DEBUGGER_IN_USE',
  'PERMISSION_DENIED',
  'FILE_ACCESS_DENIED',
  'PAGE_NOT_CAPTURABLE',
  'PICKER_CANCELLED',
  'NOTHING_SELECTED',
  'ELEMENT_GONE',
  'RENDER_FAILED',
  'EMPTY_RESULT',
  'TOO_LARGE',
  'DOWNLOAD_FAILED',
  'DOWNLOAD_CANCELLED',
  'UNKNOWN',
] as const;

export type ExportErrorCode = (typeof EXPORT_ERROR_CODES)[number];

/** The single piece of state the background worker owns and broadcasts. */
export interface ExportState {
  readonly phase: ExportPhase;
  readonly engine: ExportEngine | null;
  /** Localized, user-facing sentence. Empty while idle. */
  readonly message: string;
  readonly errorCode: ExportErrorCode | null;
  readonly filename: string | null;
  readonly updatedAt: number;
}

/** Result of the readiness pass a content script runs before rendering. */
export interface PageMetrics {
  readonly title: string;
  readonly url: string;
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly devicePixelRatio: number;
}
