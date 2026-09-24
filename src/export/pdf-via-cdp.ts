/**
 * Primary export path: chrome.debugger + Page.printToPDF.
 *
 * This is the same engine behind Chrome's own "Print to PDF", so the output is
 * a real paginated document with selectable text, not a rasterized screenshot.
 *
 * Debugger lifetime rule (01-requirements.md §4): attach immediately before the
 * single printToPDF call, detach in a finally block, including on error and on
 * timeout. The debugger is never left attached across user interactions.
 */
import {
  AUTO_MAX_IN,
  AUTO_MIN_IN,
  CSS_PX_PER_IN,
  PAGE_MARGIN_IN,
  RENDER_TIMEOUT_MS,
  paperSize,
} from '../shared/constants';
import { ExportError, toExportError } from '../shared/errors';
import type { ExportOptions, PageMetrics } from '../shared/types';

const CDP_VERSION = '1.3';

/** Subset of Page.printToPDF params this extension sets. */
interface PrintToPdfParams {
  printBackground: boolean;
  preferCSSPageSize: boolean;
  paperWidth: number;
  paperHeight: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  transferMode: 'ReturnAsBase64';
  generateTaggedPDF: boolean;
}

export interface CdpExportInput {
  readonly tabId: number;
  readonly options: ExportOptions;
  readonly metrics: PageMetrics;
}

/**
 * Chooses the printed sheet size. `auto` fits one continuous sheet to the
 * content so short pages (a single card, a receipt) don't get padded out to a
 * full A4 page, clamped so the result stays openable in a normal PDF reader.
 */
export function resolvePaper(
  options: ExportOptions,
  metrics: PageMetrics,
): { widthIn: number; heightIn: number } {
  const size = paperSize(options.paperSize);
  if (size.widthIn !== null && size.heightIn !== null) {
    return { widthIn: size.widthIn, heightIn: size.heightIn };
  }
  const clamp = (value: number) => Math.min(AUTO_MAX_IN, Math.max(AUTO_MIN_IN, value));
  return {
    widthIn: clamp(metrics.contentWidth / CSS_PX_PER_IN + PAGE_MARGIN_IN * 2),
    heightIn: clamp(metrics.contentHeight / CSS_PX_PER_IN + PAGE_MARGIN_IN * 2),
  };
}

export function buildPrintParams(options: ExportOptions, metrics: PageMetrics): PrintToPdfParams {
  const { widthIn, heightIn } = resolvePaper(options, metrics);
  // `auto` already added these margins into the sheet size above, so the same
  // value is correct for every paper size.
  const margin = PAGE_MARGIN_IN;
  return {
    printBackground: options.printBackground,
    // When the user asked to honour the page's own print stylesheet, let its
    // @page rules pick the sheet size; otherwise our paperWidth/Height wins.
    preferCSSPageSize: options.usePagePrintStyles,
    paperWidth: widthIn,
    paperHeight: heightIn,
    marginTop: margin,
    marginBottom: margin,
    marginLeft: margin,
    marginRight: margin,
    transferMode: 'ReturnAsBase64',
    // Tagged PDFs carry the page's heading/landmark structure through to the
    // file, which is what makes the output readable by a screen reader.
    generateTaggedPDF: true,
  };
}

function attach(target: chrome.debugger.Debuggee): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, CDP_VERSION, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message ?? 'debugger.attach failed'));
      else resolve();
    });
  });
}

function detach(target: chrome.debugger.Debuggee): Promise<void> {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => {
      // A detach failure means the target is already gone. Nothing to recover.
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function sendCommand<T>(
  target: chrome.debugger.Debuggee,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message ?? `${method} failed`));
      else resolve(result as T);
    });
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

export function isCdpAvailable(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.debugger?.attach === 'function';
}

/**
 * Renders the tab to PDF and returns raw base64 (no data: prefix).
 *
 * The caller is responsible for having already scoped the page — for an element
 * export the isolation stylesheet is applied by the content script before this
 * runs, because Page.printToPDF has no clip parameter (unlike captureScreenshot).
 */
export async function exportViaCdp({ tabId, options, metrics }: CdpExportInput): Promise<string> {
  if (!isCdpAvailable()) {
    throw new ExportError('DEBUGGER_UNAVAILABLE', { recoverable: true });
  }

  const target: chrome.debugger.Debuggee = { tabId };
  let attached = false;
  try {
    await attach(target);
    attached = true;
    await sendCommand(target, 'Page.enable');
    const result = await withTimeout(
      sendCommand<{ data?: string }>(target, 'Page.printToPDF', {
        ...buildPrintParams(options, metrics),
      }),
      RENDER_TIMEOUT_MS,
      'Page.printToPDF',
    );
    if (!result?.data) {
      throw new ExportError('EMPTY_RESULT', { recoverable: true });
    }
    return result.data;
  } catch (cause) {
    throw toExportError(cause);
  } finally {
    // Runs on success, failure and timeout alike — the debugger must never
    // outlive one export.
    if (attached) await detach(target);
  }
}
