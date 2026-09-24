/**
 * Injected on demand (never on page load) before an export runs.
 *
 * Its job is to make the page *look finished* before it is printed: web fonts
 * loaded, images decoded, lazy content scrolled into existence. Without this,
 * long pages export with blank image slots and fallback fonts.
 *
 * It also owns the two page-mutating passes an export needs — element isolation
 * and print-stylesheet stripping — because both must be undone afterwards, and
 * keeping the undo in the same script that applied it is what makes "the page
 * is left exactly as we found it" checkable in one place.
 */
import {
  ISOLATE_ANCESTOR_ATTR,
  ISOLATE_BREAK_ATTR,
  ISOLATE_DISPLAY_ATTR,
  ISOLATE_FLOW_ATTR,
  ISOLATE_HIDDEN_ATTR,
  ISOLATE_STYLE_ID,
  ISOLATE_TARGET_ATTR,
  READINESS_TIMEOUT_MS,
  STRIP_PRINT_STYLES_ID,
} from '../shared/constants';
import { err, isMessage, ok } from '../shared/messaging';
import type { Response, TabMessage } from '../shared/messaging';
import type { PageMetrics } from '../shared/types';

declare global {
  interface Window {
    __exporterReadinessInstalled?: true;
  }
}

const deadline = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([promise.catch(() => undefined), deadline(ms)]);
}

async function waitForFonts(budgetMs: number): Promise<void> {
  if (!document.fonts) return;
  await raceTimeout(document.fonts.ready, budgetMs);
}

async function waitForImages(budgetMs: number): Promise<void> {
  const pending = Array.from(document.images).filter((img) => !img.complete);
  if (pending.length === 0) return;
  const settled = Promise.all(
    pending.map(
      (img) =>
        new Promise<void>((resolve) => {
          const done = () => resolve();
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
        }),
    ),
  );
  await raceTimeout(settled, budgetMs);
}

/**
 * Scrolls the document end to end to trigger IntersectionObserver-based lazy
 * loading, then restores the original scroll position. Smooth scrolling is
 * temporarily disabled so this takes milliseconds rather than seconds.
 */
async function primeLazyContent(budgetMs: number): Promise<void> {
  const scroller = document.scrollingElement ?? document.documentElement;
  const originalTop = scroller.scrollTop;
  const originalBehavior = document.documentElement.style.scrollBehavior;
  document.documentElement.style.scrollBehavior = 'auto';

  const step = Math.max(200, window.innerHeight * 0.9);
  const total = scroller.scrollHeight;
  const started = Date.now();
  try {
    for (let top = 0; top < total; top += step) {
      if (Date.now() - started > budgetMs) break;
      scroller.scrollTop = top;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  } finally {
    scroller.scrollTop = originalTop;
    document.documentElement.style.scrollBehavior = originalBehavior;
  }
}

function measure(): PageMetrics {
  const doc = document.documentElement;
  const body = document.body;
  return {
    title: document.title,
    url: location.href,
    contentWidth: Math.max(doc.scrollWidth, body?.scrollWidth ?? 0, window.innerWidth),
    contentHeight: Math.max(doc.scrollHeight, body?.scrollHeight ?? 0, window.innerHeight),
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

async function waitForReady(timeoutMs: number): Promise<PageMetrics> {
  const budget = Math.max(500, Math.min(timeoutMs, READINESS_TIMEOUT_MS));
  await primeLazyContent(budget * 0.5);
  await Promise.all([waitForFonts(budget * 0.25), waitForImages(budget * 0.25)]);
  // One more frame so any layout the scroll pass triggered has settled.
  await new Promise((resolve) => requestAnimationFrame(resolve));
  return measure();
}

/* ------------------------------------------------------------------ */
/* Element isolation                                                    */
/* ------------------------------------------------------------------ */

/**
 * Page.printToPDF has no clip region (only Page.captureScreenshot does), and
 * rasterizing a clipped screenshot would throw away the selectable text that
 * makes the CDP path worth having. So instead of clipping the output, we narrow
 * the *input*: everything that is not a selected element, one of their
 * descendants, or one of their ancestors is hidden with a stylesheet, and the
 * ancestor chains are flattened so the content starts at the top-left of the
 * sheet.
 *
 * With more than one element selected, each gets `break-after: page` except the
 * last, which is what turns "several elements" into "several pages" in a single
 * printToPDF call — the alternative, printing each element separately, would
 * mean merging PDFs, which neither Chrome nor jsPDF can do.
 *
 * Nothing is removed from the DOM and no inline styles are written — this is one
 * <style> element plus marker attributes, all removed by restoreIsolation().
 */
const ISOLATION_CSS = `
  [${ISOLATE_HIDDEN_ATTR}] { display: none !important; }

  /*
    Ancestors are flattened to plain, zero-sized blocks. Every property here is
    one that can otherwise reserve space the selection does not occupy, and each
    reserved gap becomes a blank page once a forced break lands next to it:
    min-height on a full-bleed section wrapper, an aspect-ratio box, a decorative
    ::after rule, a multi-column container that swallows the break entirely.
  */
  [${ISOLATE_ANCESTOR_ATTR}] {
    display: block !important;
    position: static !important;
    float: none !important;
    overflow: visible !important;
    width: auto !important;
    height: auto !important;
    min-width: 0 !important;
    min-height: 0 !important;
    max-width: none !important;
    max-height: none !important;
    aspect-ratio: auto !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    columns: auto !important;
    contain: none !important;
    content-visibility: visible !important;
    transform: none !important;
    filter: none !important;
    opacity: 1 !important;
    background: transparent !important;
    box-shadow: none !important;
    break-inside: auto !important;
    break-before: auto !important;
    break-after: auto !important;
  }

  /* Decorative pseudo-elements on ancestors have real height. No attribute can
     hide them, so they are suppressed by rule. */
  [${ISOLATE_ANCESTOR_ATTR}]::before,
  [${ISOLATE_ANCESTOR_ATTR}]::after {
    content: none !important;
    display: none !important;
  }

  /* Flattening a table's own box would break its cells, so table ancestors keep
     the display they need — hiding their siblings is enough. */
  table[${ISOLATE_ANCESTOR_ATTR}] { display: table !important; }
  thead[${ISOLATE_ANCESTOR_ATTR}] { display: table-header-group !important; }
  tbody[${ISOLATE_ANCESTOR_ATTR}] { display: table-row-group !important; }
  tfoot[${ISOLATE_ANCESTOR_ATTR}] { display: table-footer-group !important; }
  tr[${ISOLATE_ANCESTOR_ATTR}] { display: table-row !important; }

  html[${ISOLATE_ANCESTOR_ATTR}], body[${ISOLATE_ANCESTOR_ATTR}] {
    background: transparent !important;
  }

  /* The selected element starts its own page, so its own outer margins would
     only push it down into a break. Its padding, border and background are
     untouched: those are the element as the user sees it. */
  [${ISOLATE_TARGET_ATTR}] {
    margin: 0 !important;
    float: none !important;
    break-inside: auto !important;
  }

  /* Applied only to a selection that was out of flow, so a card using
     position: relative keeps the containing block its children rely on. */
  [${ISOLATE_FLOW_ATTR}] {
    position: static !important;
    inset: auto !important;
  }

  /* An inline-level box ignores a forced break entirely, so an inline selection
     is promoted to the block-level form of whatever layout it was using. */
  [${ISOLATE_DISPLAY_ATTR}="block"] { display: block !important; }
  [${ISOLATE_DISPLAY_ATTR}="flex"] { display: flex !important; }
  [${ISOLATE_DISPLAY_ATTR}="grid"] { display: grid !important; }
  [${ISOLATE_DISPLAY_ATTR}="table"] { display: table !important; }

  [${ISOLATE_BREAK_ATTR}] {
    break-after: page !important;
    page-break-after: always !important;
  }
`;

/** Positioning that takes an element out of normal flow when printed. */
const OUT_OF_FLOW = new Set(['absolute', 'fixed', 'sticky']);

/**
 * Block-level equivalent of each inline-level display, so promoting a selection
 * keeps the layout mode its children were written against. Table displays are
 * deliberately absent: breaks already work on table rows, and blockifying one
 * would throw away the column alignment that makes it a table.
 */
const BLOCK_EQUIVALENT: Readonly<Record<string, string>> = {
  inline: 'block',
  'inline-block': 'block',
  'inline-flex': 'flex',
  'inline-grid': 'grid',
  'inline-table': 'table',
  contents: 'block',
};

const inDocumentOrder = (a: Element, b: Element): number =>
  a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;

/**
 * Hides everything outside the selection and marks the page breaks between its
 * members. Returns how many elements were kept, so the caller can report a
 * count it did not have to trust the picker for.
 */
function isolateElements(selector: string): number {
  const targets = Array.from(document.querySelectorAll(selector)).sort(inDocumentOrder);
  if (targets.length === 0) throw new Error('the selection is no longer on the page');

  restoreIsolation();

  // Everything that must stay visible: each target plus its ancestor chain.
  // A target's own descendants are never hidden, because only the siblings of
  // nodes in this set are touched.
  const keep = new Set<Element>();
  for (const target of targets) {
    for (let node: Element | null = target; node; node = node.parentElement) keep.add(node);
  }

  for (const node of keep) {
    for (const sibling of Array.from(node.parentElement?.children ?? [])) {
      if (!keep.has(sibling)) sibling.setAttribute(ISOLATE_HIDDEN_ATTR, '');
    }
  }
  for (const node of keep) {
    if (!targets.includes(node)) node.setAttribute(ISOLATE_ANCESTOR_ATTR, '');
  }
  const sheet = document.createElement('style');
  sheet.id = ISOLATE_STYLE_ID;
  sheet.textContent = ISOLATION_CSS;
  document.head.appendChild(sheet);

  // Deliberately after the stylesheet is live: flattening the ancestors can
  // change what a target's own display computes to. A card inside a flex
  // container reports `block` while it is a flex item — CSS blockifies flex
  // items — and reverts to its authored `inline-block` the moment that
  // container becomes a plain block. Reading first would miss exactly the case
  // this promotion exists for, and the forced break would be silently ignored.
  for (const target of targets) {
    target.setAttribute(ISOLATE_TARGET_ATTR, '');
    const style = getComputedStyle(target);
    if (OUT_OF_FLOW.has(style.position)) target.setAttribute(ISOLATE_FLOW_ATTR, '');
    const blockLevel = BLOCK_EQUIVALENT[style.display];
    if (blockLevel) target.setAttribute(ISOLATE_DISPLAY_ATTR, blockLevel);
  }
  // Every target but the last starts the one after it on a fresh page.
  for (const target of targets.slice(0, -1)) target.setAttribute(ISOLATE_BREAK_ATTR, '');

  return targets.length;
}

/**
 * Neutralizes the page's own print stylesheet so the export reflects what the
 * user sees on screen. Some sites hide their entire main content in `@media
 * print`, which would otherwise produce a blank PDF.
 */
function stripPrintStyles(strip: boolean): void {
  document.getElementById(STRIP_PRINT_STYLES_ID)?.remove();
  if (!strip) return;

  const disabled: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    const media = sheet.media?.mediaText ?? '';
    if (/\bprint\b/i.test(media) && !/\bscreen\b/i.test(media)) {
      disabled.push(sheet.href ?? '');
    }
  }
  // Rather than mutate every stylesheet (which cross-origin CSSOM forbids),
  // re-assert the screen appearance for print with one high-specificity sheet.
  const style = document.createElement('style');
  style.id = STRIP_PRINT_STYLES_ID;
  style.media = 'print';
  style.textContent = `
    *, *::before, *::after {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    html, body { display: block !important; visibility: visible !important; }
  `;
  document.head.appendChild(style);
  if (disabled.length > 0) {
    console.debug('[exporter] page has print-only stylesheets:', disabled);
  }
}

/**
 * Undoes isolation only. Kept separate from the print-stylesheet pass because
 * isolation re-runs itself defensively, and a combined reset would silently drop
 * the print-style override applied moments earlier.
 */
function restoreIsolation(): void {
  document.getElementById(ISOLATE_STYLE_ID)?.remove();
  for (const attr of [
    ISOLATE_HIDDEN_ATTR,
    ISOLATE_ANCESTOR_ATTR,
    ISOLATE_BREAK_ATTR,
    ISOLATE_TARGET_ATTR,
    ISOLATE_FLOW_ATTR,
    ISOLATE_DISPLAY_ATTR,
  ]) {
    for (const node of Array.from(document.querySelectorAll(`[${attr}]`))) {
      node.removeAttribute(attr);
    }
  }
}

function restorePage(): void {
  restoreIsolation();
  document.getElementById(STRIP_PRINT_STYLES_ID)?.remove();
}

/* ------------------------------------------------------------------ */

function install(): void {
  if (window.__exporterReadinessInstalled) return;
  window.__exporterReadinessInstalled = true;

  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    // Only the extension's own service worker may drive these. A message with
    // no sender.id, or a foreign id, is ignored outright.
    if (sender.id !== chrome.runtime.id) return false;
    if (!isMessage(raw)) return false;
    const message = raw as TabMessage;

    const reply = (response: Response<unknown>) => sendResponse(response);
    const guard = (fn: () => void) => {
      try {
        fn();
        reply(ok(null));
      } catch (cause) {
        reply(err(cause instanceof Error ? cause.message : String(cause)));
      }
    };

    switch (message.type) {
      case 'WAIT_FOR_READY':
        waitForReady(message.timeoutMs).then(
          (metrics) => reply(ok(metrics)),
          (cause: unknown) => reply(err(cause instanceof Error ? cause.message : String(cause))),
        );
        return true;
      case 'ISOLATE_ELEMENTS':
        try {
          reply(ok({ count: isolateElements(message.selector) }));
        } catch (cause) {
          reply(err(cause instanceof Error ? cause.message : String(cause)));
        }
        return true;
      case 'STRIP_PRINT_STYLES':
        guard(() => stripPrintStyles(message.strip));
        return true;
      case 'RESTORE_PAGE':
        guard(restorePage);
        return true;
      default:
        return false;
    }
  });
}

install();
