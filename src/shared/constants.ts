import type { ExportOptions, PaperSize, PaperSizeId } from './types';

/**
 * Attribute the element picker stamps on every chosen node. It doubles as the
 * selector: one attribute selector matches the whole selection, however many
 * elements are in it, so nothing downstream has to carry a list of paths.
 */
export const SELECTED_ATTR = 'data-exporter-selected';
export const SELECTED_SELECTOR = `[${SELECTED_ATTR}]`;

/** Most elements a single export will accept, to keep render times sane. */
export const MAX_SELECTED_ELEMENTS = 30;

/** Attributes/ids used by the print-isolation pass. All removed after export. */
export const ISOLATE_HIDDEN_ATTR = 'data-exporter-hidden';
export const ISOLATE_ANCESTOR_ATTR = 'data-exporter-ancestor';
/** Forces a page break after a selected element, so the next one starts a page. */
export const ISOLATE_BREAK_ATTR = 'data-exporter-break';
/** Marks a selected element that has to be pulled back into normal flow. */
export const ISOLATE_FLOW_ATTR = 'data-exporter-flow';
/** Marks the selected elements themselves, so their own box can be normalized. */
export const ISOLATE_TARGET_ATTR = 'data-exporter-target';
/**
 * Carries the block-level display an inline selection is promoted to. A forced
 * page break has no effect on an inline-level box, so an inline-block card would
 * otherwise share a page with the next selection.
 */
export const ISOLATE_DISPLAY_ATTR = 'data-exporter-display';
export const ISOLATE_STYLE_ID = 'exporter-isolate-style';
export const STRIP_PRINT_STYLES_ID = 'exporter-strip-print-style';

export const CONTEXT_MENU_EXPORT_PAGE = 'exporter.page';
export const CONTEXT_MENU_EXPORT_SELECTION = 'exporter.selection';

export const STORAGE_KEY_OPTIONS = 'exporter.options.v1';

export const PAPER_SIZES: readonly PaperSize[] = [
  { id: 'a4', labelKey: 'paperA4', widthIn: 8.27, heightIn: 11.69 },
  { id: 'letter', labelKey: 'paperLetter', widthIn: 8.5, heightIn: 11 },
  { id: 'legal', labelKey: 'paperLegal', widthIn: 8.5, heightIn: 14 },
  { id: 'tabloid', labelKey: 'paperTabloid', widthIn: 11, heightIn: 17 },
  { id: 'auto', labelKey: 'paperAuto', widthIn: null, heightIn: null },
];

export const DEFAULT_OPTIONS: ExportOptions = {
  format: 'pdf',
  paperSize: 'a4',
  printBackground: true,
  usePagePrintStyles: false,
};

/** Printed margin, in inches, applied on every side. */
export const PAGE_MARGIN_IN = 0.4;

/** CSS pixels per inch, as assumed by both CDP printing and jsPDF here. */
export const CSS_PX_PER_IN = 96;

/**
 * `auto` clamps to something a PDF reader can still open sensibly rather than
 * emitting a single 30,000pt-tall page.
 */
export const AUTO_MIN_IN = 3;
export const AUTO_MAX_IN = 200;

/**
 * chrome.downloads.download is handed a `data:` URL (service workers have no
 * URL.createObjectURL). Chrome caps those well below this, but a hard limit
 * here turns a mystery failure into the specific TOO_LARGE message.
 */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

/** URL schemes and hosts where no extension can inject or attach a debugger. */
export const RESTRICTED_SCHEMES = [
  'chrome:',
  'chrome-untrusted:',
  'chrome-extension:',
  'chrome-search:',
  'devtools:',
  'edge:',
  'brave:',
  'opera:',
  'vivaldi:',
  'about:',
  'view-source:',
  'data:',
] as const;

/** Chrome blocks all extension script injection on these hosts by policy. */
export const RESTRICTED_HOSTS = [
  'chromewebstore.google.com',
  'chrome.google.com',
] as const;

/** How long the readiness pass waits for fonts, images and lazy content. */
export const READINESS_TIMEOUT_MS = 8_000;
/** Ceiling on a single CDP printToPDF call before it is treated as failed. */
export const RENDER_TIMEOUT_MS = 60_000;

export function paperSize(id: PaperSizeId): PaperSize {
  const found = PAPER_SIZES.find((size) => size.id === id);
  if (!found) throw new Error(`unknown paper size: ${id}`);
  return found;
}
