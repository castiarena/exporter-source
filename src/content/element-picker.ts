/**
 * Element picker: hover to highlight, click to add to the selection, Enter to
 * export, Esc to cancel.
 *
 * Several elements can be picked in one session; each becomes a page in the
 * resulting PDF, in document order. Because the page order is the document's,
 * not the click order, the badge on each pick shows the page it will become and
 * is renumbered as the selection changes — otherwise the numbers would lie.
 *
 * Injected only on explicit user action (context menu entry or popup button) —
 * never declaratively on page load. See manifest.json: there is no
 * "content_scripts" key at all, so nothing here can run unless the background
 * worker injects it into the tab the user just acted on.
 *
 * The page is not modified: the overlay lives inside a closed shadow root on a
 * single host element, and the only trace left on the page after a selection is
 * one marker attribute per pick, which the background worker has removed once
 * the export finishes.
 */
import { MAX_SELECTED_ELEMENTS, SELECTED_ATTR } from '../shared/constants';
import { err, isMessage, ok, sendToBackground } from '../shared/messaging';
import type { Response, TabMessage } from '../shared/messaging';
import { ordinalMessage } from '../shared/ordinals';
import type { ElementRect } from '../shared/types';

declare global {
  interface Window {
    __exporterPickerInstalled?: true;
  }
}

const HOST_ID = 'exporter-picker-host';

const OVERLAY_CSS = `
  :host { all: initial; }
  .box, .pick {
    position: fixed;
    z-index: 2147483647;
    pointer-events: none;
    border-radius: 2px;
  }
  .box {
    border: 2px dashed #2f6fed;
    background: rgba(47, 111, 237, 0.08);
    transition: all 60ms linear;
  }
  .pick {
    border: 2px solid #2f6fed;
    background: rgba(47, 111, 237, 0.16);
  }
  .label, .badge {
    position: fixed;
    z-index: 2147483647;
    pointer-events: none;
    font: 600 11px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
    color: #fff;
    background: #2f6fed;
    border-radius: 3px;
    white-space: nowrap;
  }
  /* Outlined, to read as "this is what you would get" against the solid badge
     of an element already picked — the two can name the same position, since
     picking something earlier in the page pushes the rest down. */
  .label {
    padding: 1px 7px;
    color: #2f6fed;
    background: #fff;
    border: 1px dashed #2f6fed;
    max-width: 60vw;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .label.is-hidden { display: none; }
  .badge {
    padding: 2px 8px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
  }
  .bar {
    position: fixed;
    z-index: 2147483647;
    left: 50%;
    bottom: 24px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 12px;
    pointer-events: none;
    font: 500 12px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
    color: #fff;
    background: rgba(17, 17, 17, 0.92);
    padding: 8px 10px 8px 14px;
    border-radius: 999px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    max-width: 90vw;
  }
  .bar .hint { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar .done {
    /* The only interactive part of the overlay, for mouse-only use. */
    pointer-events: auto;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    color: #fff;
    background: #2f6fed;
    border: 0;
    border-radius: 999px;
    padding: 5px 12px;
  }
  .bar .done[disabled] { opacity: 0.45; cursor: default; }
`;

const t = (key: string, substitutions?: readonly string[], fallback = '') =>
  chrome.i18n.getMessage(key, substitutions as string[] | undefined) || fallback;

/** The name of a position, e.g. 0 -> "First". */
function ordinalName(index: number): string {
  const message = ordinalMessage(index);
  return t(message.key, message.substitutions, `No. ${index + 1}`);
}

function rectOf(element: Element): ElementRect {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left + window.scrollX,
    y: rect.top + window.scrollY,
    width: rect.width,
    height: rect.height,
  };
}

/** Elements too small or invisible to be a meaningful export target. */
function isPickable(element: Element | null): element is Element {
  if (!element) return false;
  if (element.id === HOST_ID) return false;
  if (element === document.documentElement) return false;
  const rect = element.getBoundingClientRect();
  return rect.width >= 8 && rect.height >= 8;
}

const inDocumentOrder = (a: Element, b: Element): number =>
  a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;

/** True when one element contains the other, in either direction. */
const overlaps = (a: Element, b: Element): boolean => a.contains(b) || b.contains(a);

class Picker {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private hoverBox: HTMLElement | null = null;
  private hoverLabel: HTMLElement | null = null;
  private picksLayer: HTMLElement | null = null;
  private hint: HTMLElement | null = null;
  private done: HTMLButtonElement | null = null;

  /** Kept in document order, which is also the page order of the export. */
  private picks: Element[] = [];
  private hovered: Element | null = null;
  private active = false;

  start(): void {
    if (this.active) return;
    this.active = true;
    this.picks = [];
    this.clearStaleMarkers();
    this.buildOverlay();

    // Capture phase everywhere, so the page's own handlers never see these.
    window.addEventListener('mousemove', this.onMouseMove, true);
    window.addEventListener('click', this.onClick, true);
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('scroll', this.reposition, true);
    window.addEventListener('resize', this.reposition, true);
    window.addEventListener('blur', this.onBlur, true);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    window.removeEventListener('mousemove', this.onMouseMove, true);
    window.removeEventListener('click', this.onClick, true);
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('scroll', this.reposition, true);
    window.removeEventListener('resize', this.reposition, true);
    window.removeEventListener('blur', this.onBlur, true);
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.hovered = null;
  }

  private clearStaleMarkers(): void {
    for (const stale of Array.from(document.querySelectorAll(`[${SELECTED_ATTR}]`))) {
      stale.removeAttribute(SELECTED_ATTR);
    }
  }

  private buildOverlay(): void {
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('aria-hidden', 'true');
    // `closed` so the page cannot reach in and read or rewrite the overlay.
    const root = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;

    const hoverBox = document.createElement('div');
    hoverBox.className = 'box';
    const hoverLabel = document.createElement('div');
    hoverLabel.className = 'label';
    const picksLayer = document.createElement('div');

    const bar = document.createElement('div');
    bar.className = 'bar';
    const hint = document.createElement('span');
    hint.className = 'hint';
    const done = document.createElement('button');
    done.className = 'done';
    done.type = 'button';
    bar.append(hint, done);

    root.append(style, hoverBox, hoverLabel, picksLayer, bar);
    document.documentElement.appendChild(host);

    this.host = host;
    this.root = root;
    this.hoverBox = hoverBox;
    this.hoverLabel = hoverLabel;
    this.picksLayer = picksLayer;
    this.hint = hint;
    this.done = done;
    this.renderBar();
  }

  /* ---------------------------------------------------------------- */
  /* Selection                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Adds or removes an element.
   *
   * Picking something that contains, or sits inside, an existing pick replaces
   * the ones it overlaps. Any other rule would let the same content land in the
   * PDF twice, and "the newest pick wins" is the one a user can predict.
   */
  private toggle(element: Element): void {
    const existing = this.picks.indexOf(element);
    if (existing !== -1) {
      this.picks[existing]?.removeAttribute(SELECTED_ATTR);
      this.picks.splice(existing, 1);
      this.renderPicks();
      return;
    }

    if (this.picks.length >= MAX_SELECTED_ELEMENTS) {
      this.flashHint(
        t('pickerTooMany', [String(MAX_SELECTED_ELEMENTS)], `At most ${MAX_SELECTED_ELEMENTS}.`),
      );
      return;
    }

    for (const other of this.picks.filter((pick) => overlaps(pick, element))) {
      other.removeAttribute(SELECTED_ATTR);
      this.picks.splice(this.picks.indexOf(other), 1);
    }

    element.setAttribute(SELECTED_ATTR, '');
    this.picks.push(element);
    this.picks.sort(inDocumentOrder);
    this.renderPicks();
  }

  /**
   * Where this element would land if clicked — its current position if it is
   * already picked, otherwise the position it would take once the picks it
   * overlaps are dropped. Mirrors toggle() exactly, so the label cannot promise
   * a position the click will not deliver.
   *
   * Returns null when the element cannot be added at all.
   */
  private positionOf(element: Element): number | null {
    const existing = this.picks.indexOf(element);
    if (existing !== -1) return existing;

    const kept = this.picks.filter((pick) => !overlaps(pick, element));
    if (kept.length >= MAX_SELECTED_ELEMENTS) return null;
    return [...kept, element].sort(inDocumentOrder).indexOf(element);
  }

  private finish(): void {
    if (this.picks.length === 0) {
      // Enter with an empty selection is a misunderstanding, not a mistake to
      // be punished by cancelling — say what is missing and stay open.
      this.flashHint(t('pickerNothingPicked', undefined, 'Pick at least one element first.'));
      return;
    }
    const rects = this.picks.map(rectOf);
    this.stop();
    void sendToBackground({ type: 'PICKER_RESULT', selector: `[${SELECTED_ATTR}]`, rects });
  }

  private cancel(): void {
    this.clearStaleMarkers();
    this.picks = [];
    this.stop();
    void sendToBackground({ type: 'PICKER_CANCELLED' });
  }

  /* ---------------------------------------------------------------- */
  /* Painting                                                           */
  /* ---------------------------------------------------------------- */

  private place(node: HTMLElement, rect: DOMRect): void {
    node.style.left = `${rect.left}px`;
    node.style.top = `${rect.top}px`;
    node.style.width = `${rect.width}px`;
    node.style.height = `${rect.height}px`;
  }

  private renderPicks(): void {
    if (!this.picksLayer) return;
    this.picksLayer.replaceChildren();

    this.picks.forEach((element, index) => {
      const rect = element.getBoundingClientRect();
      const box = document.createElement('div');
      box.className = 'pick';
      this.place(box, rect);

      const badge = document.createElement('div');
      badge.className = 'badge';
      // The page this element will become, not the order it was clicked in.
      badge.textContent = ordinalName(index);
      badge.style.left = `${Math.max(4, rect.left - 4)}px`;
      badge.style.top = `${Math.max(4, rect.top - 4)}px`;

      this.picksLayer?.append(box, badge);
    });

    this.renderBar();
    // Picking or unpicking shifts the positions of everything after it, so the
    // hovered element's label has to be recomputed alongside the badges.
    this.highlight(this.hovered);
  }

  private renderBar(): void {
    if (!this.hint || !this.done) return;
    const count = this.picks.length;
    this.hint.textContent =
      count === 0
        ? t('pickerHint', undefined, 'Click elements to add them · Esc to cancel')
        : t('pickerHintSelected', [String(count)], `${count} selected — each becomes a page`);
    this.done.textContent = t('pickerExportButton', undefined, 'Export');
    this.done.disabled = count === 0;
  }

  /** Temporarily replaces the hint to explain why a click did nothing. */
  private flashHint(text: string): void {
    if (!this.hint) return;
    this.hint.textContent = text;
    setTimeout(() => this.renderBar(), 1600);
  }

  private reposition = (): void => {
    // renderPicks() refreshes the hover label too.
    this.renderPicks();
  };

  private highlight(element: Element | null): void {
    this.hovered = element;
    if (!this.hoverBox || !this.hoverLabel) return;
    if (!element) {
      this.hoverBox.style.width = '0px';
      this.hoverLabel.textContent = '';
      return;
    }
    const rect = element.getBoundingClientRect();
    this.place(this.hoverBox, rect);
    // Names the page this element would become. A tag-and-class caption would
    // describe the site's markup, which is not what someone choosing what to
    // export is looking for.
    // An element that is already picked wears its badge; repeating the name in
    // a hover label right beside it is noise.
    const alreadyPicked = this.picks.includes(element);
    const position = this.positionOf(element);
    this.hoverLabel.classList.toggle('is-hidden', alreadyPicked);
    this.hoverLabel.textContent = alreadyPicked
      ? ''
      : position === null
        ? t('pickerSelectionFull', undefined, 'Selection full')
        : ordinalName(position);
    // Sit the label above the box, or inside it when there is no room above.
    this.hoverLabel.style.left = `${Math.max(4, rect.left)}px`;
    this.hoverLabel.style.top = rect.top >= 22 ? `${rect.top - 20}px` : `${rect.top + 4}px`;
  }

  /* ---------------------------------------------------------------- */
  /* Input                                                              */
  /* ---------------------------------------------------------------- */

  private onMouseMove = (event: MouseEvent): void => {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (isPickable(element) && element !== this.hovered) this.highlight(element);
  };

  private onBlur = (): void => {
    // Cancelling on blur cleans up an overlay the user has walked away from —
    // but only while there is nothing to lose. Once elements are picked,
    // leaving the tab and coming back must not silently discard the work.
    if (this.picks.length === 0) this.cancel();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    const swallow = () => {
      event.preventDefault();
      event.stopPropagation();
    };

    if (event.key === 'Escape') {
      swallow();
      this.cancel();
      return;
    }
    if (event.key === 'Enter') {
      swallow();
      this.finish();
      return;
    }
    if (event.key === ' ' && this.hovered) {
      swallow();
      this.toggle(this.hovered);
      return;
    }
    if (event.key === 'ArrowUp' && this.hovered?.parentElement) {
      swallow();
      this.highlight(this.hovered.parentElement);
      return;
    }
    if (event.key === 'ArrowDown' && this.hovered) {
      const child = Array.from(this.hovered.children).find(isPickable);
      if (child) {
        swallow();
        this.highlight(child);
      }
    }
  };

  private onClick = (event: MouseEvent): void => {
    // Clicks land on the host, not the overlay's internals, because the shadow
    // root is closed and retargets them. Everything in the overlay is
    // pointer-events:none except the Export button, so a click that reaches the
    // host can only have come from there.
    if (this.host && event.target === this.host) {
      const inner = this.root?.elementFromPoint(event.clientX, event.clientY);
      event.preventDefault();
      event.stopPropagation();
      if (this.done && inner === this.done && !this.done.disabled) this.finish();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (isPickable(element)) this.toggle(element);
  };
}

function install(): void {
  if (window.__exporterPickerInstalled) return;
  window.__exporterPickerInstalled = true;

  const picker = new Picker();

  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (!isMessage(raw)) return false;
    const message = raw as TabMessage;
    const reply = (response: Response<unknown>) => sendResponse(response);

    try {
      if (message.type === 'START_PICKER') {
        picker.start();
        reply(ok(null));
        return true;
      }
      if (message.type === 'STOP_PICKER') {
        picker.stop();
        reply(ok(null));
        return true;
      }
    } catch (cause) {
      reply(err(cause instanceof Error ? cause.message : String(cause)));
      return true;
    }
    return false;
  });
}

install();
