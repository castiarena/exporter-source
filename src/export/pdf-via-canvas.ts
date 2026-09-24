/**
 * Fallback export path: vendored html2canvas + jsPDF, no chrome.debugger.
 *
 * Used when the CDP path is unavailable — the debugger permission was declined,
 * DevTools already owns the tab, or attach failed for any other recoverable
 * reason. It rasterizes the DOM and paginates the resulting bitmap, so the text
 * in the PDF is not selectable. That fidelity loss is exactly why this is the
 * fallback and not the default (02-project-structure.md §1).
 *
 * Unlike the CDP path, this one does not need the page isolated: it renders each
 * selected element directly, so "each element is a page" falls out of rendering
 * them one at a time and starting a new page for each.
 *
 * This module is built as a standalone content script: html2canvas needs a real
 * document, which a service worker does not have. Both libraries are imported
 * from vendor/ and bundled in — nothing is fetched at runtime.
 */
import html2canvas from '../../vendor/html2canvas/html2canvas.esm.js';
import { jsPDF } from '../../vendor/jspdf/jspdf.es.min.js';
import {
  AUTO_MAX_IN,
  AUTO_MIN_IN,
  CSS_PX_PER_IN,
  PAGE_MARGIN_IN,
  SELECTED_SELECTOR,
  paperSize,
} from '../shared/constants';
import { err, isMessage, ok } from '../shared/messaging';
import type { Response, TabMessage } from '../shared/messaging';
import type { ExportOptions } from '../shared/types';

declare global {
  interface Window {
    __exporterCanvasInstalled?: true;
  }
}

/** Cap on the rendered bitmap's longest edge; browsers refuse larger canvases. */
const MAX_CANVAS_PX = 16_384;
/** Rendering above 2x costs memory without visibly improving a printed page. */
const MAX_SCALE = 2;

const inDocumentOrder = (a: Element, b: Element): number =>
  a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;

/** The elements to render, in the order they will appear as pages. */
function resolveTargets(selector: string | null): HTMLElement[] {
  if (!selector) return [document.body];
  const found = Array.from(document.querySelectorAll<HTMLElement>(selector));
  if (found.length === 0) throw new Error('the selection is no longer on the page');
  return found.sort(inDocumentOrder);
}

/** Keeps the bitmap inside browser canvas limits for very long elements. */
function scaleFor(element: HTMLElement): number {
  const longest = Math.max(element.scrollWidth, element.scrollHeight, 1);
  return Math.min(MAX_SCALE, window.devicePixelRatio || 1, MAX_CANVAS_PX / longest);
}

/** A rendered element, with the scale it was rendered at. */
interface Rendered {
  readonly canvas: HTMLCanvasElement;
  /** Device pixels per CSS pixel, needed to turn canvas pixels into inches. */
  readonly scale: number;
}

async function render(element: HTMLElement, options: ExportOptions): Promise<Rendered> {
  const scale = scaleFor(element);
  const canvas = await html2canvas(element, {
    scale,
    useCORS: true,
    // Deliberately false: allowTaint would let cross-origin images poison the
    // canvas, and a tainted canvas cannot be read back at all.
    allowTaint: false,
    // null keeps whatever the page itself paints; the roadmap's transparent-PNG
    // feature (04-roadmap.md v1.2) hangs off this same switch.
    backgroundColor: options.printBackground ? null : '#ffffff',
    logging: false,
    removeContainer: true,
    scrollX: 0,
    scrollY: 0,
    windowWidth: document.documentElement.clientWidth,
    windowHeight: document.documentElement.clientHeight,
  });
  if (canvas.width === 0 || canvas.height === 0) {
    throw new Error('an element rendered as an empty image');
  }
  return { canvas, scale };
}

/** Source size in inches, i.e. how big the element is on screen. */
const widthIn = ({ canvas, scale }: Rendered) => canvas.width / (CSS_PX_PER_IN * scale);
const heightIn = ({ canvas, scale }: Rendered) => canvas.height / (CSS_PX_PER_IN * scale);

interface Sheet {
  readonly widthIn: number;
  readonly heightIn: number;
}

/**
 * One sheet size for the whole document — a PDF may mix page sizes, but a file
 * whose pages change shape halfway through prints badly and reads worse. For
 * `auto` that means the sheet fits the largest element, and smaller ones sit on
 * a page with room to spare.
 */
function resolveSheet(options: ExportOptions, rendered: readonly Rendered[]): Sheet {
  const size = paperSize(options.paperSize);
  if (size.widthIn !== null && size.heightIn !== null) {
    return { widthIn: size.widthIn, heightIn: size.heightIn };
  }
  const clamp = (value: number) => Math.min(AUTO_MAX_IN, Math.max(AUTO_MIN_IN, value));
  return {
    widthIn: clamp(Math.max(...rendered.map(widthIn)) + PAGE_MARGIN_IN * 2),
    heightIn: clamp(Math.max(...rendered.map(heightIn)) + PAGE_MARGIN_IN * 2),
  };
}

/**
 * Slices one bitmap across as many pages as it needs, starting at the pdf's
 * current page.
 *
 * Each slice is copied into a page-sized scratch canvas rather than drawn with a
 * negative offset, because jsPDF stores whatever image it is handed —
 * offsetting would embed the whole bitmap once per page and produce a file N
 * times larger than it needs to be.
 */
function addPagesFor(
  pdf: InstanceType<typeof jsPDF>,
  rendered: Rendered,
  sheet: Sheet,
  options: ExportOptions,
  startsNewPage: boolean,
): void {
  const { canvas, scale } = rendered;
  const pxPerIn = CSS_PX_PER_IN * scale;
  const printableWidthIn = sheet.widthIn - PAGE_MARGIN_IN * 2;
  const printableHeightIn = sheet.heightIn - PAGE_MARGIN_IN * 2;

  // Fit to width; height then follows from the source aspect ratio.
  const fit = printableWidthIn / widthIn(rendered);
  const sliceHeightPx = Math.max(1, Math.floor((printableHeightIn / fit) * pxPerIn));

  const scratch = document.createElement('canvas');
  const ctx = scratch.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');

  const pageCount = Math.max(1, Math.ceil(canvas.height / sliceHeightPx));
  for (let page = 0; page < pageCount; page += 1) {
    if (startsNewPage || page > 0) pdf.addPage([sheet.widthIn, sheet.heightIn]);

    const sourceY = page * sliceHeightPx;
    const sourceHeight = Math.min(sliceHeightPx, canvas.height - sourceY);
    scratch.width = canvas.width;
    scratch.height = sourceHeight;
    if (options.printBackground) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, scratch.width, scratch.height);
    } else {
      ctx.clearRect(0, 0, scratch.width, scratch.height);
    }
    ctx.drawImage(canvas, 0, sourceY, canvas.width, sourceHeight, 0, 0, canvas.width, sourceHeight);

    pdf.addImage(
      scratch.toDataURL('image/png'),
      'PNG',
      PAGE_MARGIN_IN,
      PAGE_MARGIN_IN,
      printableWidthIn,
      (sourceHeight / pxPerIn) * fit,
      undefined,
      'FAST',
    );
  }
}

function buildPdf(rendered: readonly Rendered[], options: ExportOptions): string {
  const sheet = resolveSheet(options, rendered);
  const pdf = new jsPDF({
    unit: 'in',
    format: [sheet.widthIn, sheet.heightIn],
    orientation: sheet.widthIn > sheet.heightIn ? 'landscape' : 'portrait',
    compress: true,
  });

  // jsPDF opens with one page already, so only elements after the first ask for
  // a new one — which is what makes each selected element start its own page.
  rendered.forEach((item, index) => addPagesFor(pdf, item, sheet, options, index > 0));

  // 'datauristring' -> "data:application/pdf;filename=...;base64,XXXX"; the
  // background worker wants raw base64, so hand back only the payload.
  const dataUri = pdf.output('datauristring') as string;
  const marker = 'base64,';
  const index = dataUri.indexOf(marker);
  if (index === -1) throw new Error('jsPDF returned an unexpected output format');
  return dataUri.slice(index + marker.length);
}

export async function renderPdfInPage(
  options: ExportOptions,
  selector: string | null,
): Promise<string> {
  const targets = resolveTargets(selector);
  const rendered: Rendered[] = [];
  // Sequentially, not in parallel: html2canvas clones the subtree it is
  // rendering into the live document, and several clones at once both thrash
  // memory and let one render observe another's scratch nodes.
  for (const target of targets) rendered.push(await render(target, options));
  return buildPdf(rendered, options);
}

function install(): void {
  if (window.__exporterCanvasInstalled) return;
  window.__exporterCanvasInstalled = true;

  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (!isMessage(raw)) return false;
    const message = raw as TabMessage;
    if (message.type !== 'RENDER_CANVAS_PDF') return false;

    const reply = (response: Response<unknown>) => sendResponse(response);
    renderPdfInPage(
      message.options,
      message.selector === null ? null : message.selector || SELECTED_SELECTOR,
    ).then(
      (base64) => reply(ok({ base64 })),
      (cause: unknown) => reply(err(cause instanceof Error ? cause.message : String(cause))),
    );
    return true;
  });
}

install();
