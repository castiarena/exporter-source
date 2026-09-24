/**
 * MV3 background service worker: the only place that owns export state.
 *
 * Responsibilities:
 *  - register the two context-menu entries
 *  - route every typed message from the popup, options page and content scripts
 *  - orchestrate one export at a time: readiness -> render -> restore -> save
 *  - pick the CDP path, fall back to canvas, and always put the page back
 *
 * The worker stays unloaded until something invokes it (01-requirements.md §3),
 * so anything that must survive a restart lives in chrome.storage.session, not
 * in a module-level closure.
 */
import { exportViaCdp, isCdpAvailable } from '../export/pdf-via-cdp';
import { buildFilename } from '../export/filename';
import {
  CONTEXT_MENU_EXPORT_PAGE,
  CONTEXT_MENU_EXPORT_SELECTION,
  DEFAULT_OPTIONS,
  MAX_DOWNLOAD_BYTES,
  READINESS_TIMEOUT_MS,
  SELECTED_ATTR,
  STORAGE_KEY_OPTIONS,
} from '../shared/constants';
import { ExportError, messageKeyFor, restrictionFor, toExportError } from '../shared/errors';
import { broadcast, err, isMessage, ok, sendToTab } from '../shared/messaging';
import type { AnyMessage, Response } from '../shared/messaging';
import type {
  ExportEngine,
  ExportErrorCode,
  ExportOptions,
  ExportPhase,
  ExportState,
  PageMetrics,
} from '../shared/types';

const SCRIPTS = {
  readiness: 'content/page-readiness.js',
  picker: 'content/element-picker.js',
  canvas: 'content/pdf-via-canvas.js',
} as const;

const PENDING_KEY = 'exporter.pendingElementExport';

/**
 * An element export spans two turns of the worker — start the picker, then wait
 * for the user to click. MV3 can stop the worker in between, so this lives in
 * chrome.storage.session rather than in a closure.
 */
interface PendingElementExport {
  readonly tabId: number;
  readonly options: ExportOptions;
  /** Only ever read by a human looking at a stale record in devtools. */
  readonly startedAt: number;
}

/**
 * How many elements the running export covers; 0 means the whole page. Used
 * only to phrase the success message, so a stale value cannot affect output.
 */
let elementCount = 0;

/* ------------------------------------------------------------------ */
/* State                                                                */
/* ------------------------------------------------------------------ */

let state: ExportState = {
  phase: 'idle',
  engine: null,
  message: '',
  errorCode: null,
  filename: null,
  updatedAt: Date.now(),
};

const t = (key: string, substitutions?: string[]) =>
  chrome.i18n.getMessage(key, substitutions) || key;

function setState(next: Partial<ExportState>): ExportState {
  state = { ...state, ...next, updatedAt: Date.now() };
  broadcast({ type: 'STATE_CHANGED', state });
  return state;
}

function setPhase(phase: ExportPhase, messageKey: string, engine: ExportEngine | null = state.engine) {
  return setState({ phase, engine, message: t(messageKey), errorCode: null });
}

function setError(code: ExportErrorCode) {
  return setState({ phase: 'error', message: t(messageKeyFor(code)), errorCode: code });
}

/* ------------------------------------------------------------------ */
/* Options persistence                                                  */
/* ------------------------------------------------------------------ */

export async function loadOptions(): Promise<ExportOptions> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY_OPTIONS);
    const value = stored[STORAGE_KEY_OPTIONS] as Partial<ExportOptions> | undefined;
    return { ...DEFAULT_OPTIONS, ...(value ?? {}) };
  } catch {
    return DEFAULT_OPTIONS;
  }
}

/* ------------------------------------------------------------------ */
/* Tab helpers                                                          */
/* ------------------------------------------------------------------ */

const isOwnPage = (url: string | undefined): boolean =>
  url !== undefined && url.startsWith(`chrome-extension://${chrome.runtime.id}/`);

/**
 * Finds the tab the user meant to export.
 *
 * Normally that is simply the active tab in the current window. The extension's
 * own pages are skipped: the options page opens in a tab, and "export the
 * options page" is never what someone clicking Export meant. When the current
 * window offers nothing exportable — the options tab is focused, or the popup is
 * detached into its own window — the search widens to the active tab of every
 * normal browser window, most recently used first.
 */
async function activeTab(): Promise<chrome.tabs.Tab> {
  const byRecency = (tabs: chrome.tabs.Tab[]) =>
    [...tabs].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  // `tab.url` is only populated for tabs the extension can actually reach —
  // which, with no host permissions, means the one activeTab just granted. A
  // tab with no visible URL is therefore one this extension could not export
  // even if it picked it, so it is not a candidate.
  const usable = (tabs: chrome.tabs.Tab[]) =>
    byRecency(tabs).find(
      (candidate) => candidate.id !== undefined && candidate.url && !isOwnPage(candidate.url),
    );

  const inCurrentWindow = await chrome.tabs.query({ active: true, currentWindow: true });
  const inNormalWindows = await chrome.tabs.query({ active: true, windowType: 'normal' });

  const tab = usable(inCurrentWindow) ?? usable(inNormalWindows);
  if (tab) {
    const restriction = restrictionFor(tab.url);
    if (restriction) throw new ExportError(restriction);
    return tab;
  }

  // No tab anywhere has a URL this extension can see. If there is a tab at all,
  // that is Chrome withholding access — a chrome:// page, say — and the user
  // should be told that, not told there is no tab open.
  const anyTab = [...inCurrentWindow, ...inNormalWindows].some((t) => t.id !== undefined);
  throw new ExportError(anyTab ? 'RESTRICTED_PAGE' : 'NO_ACTIVE_TAB');
}

async function inject(tab: chrome.tabs.Tab, file: string): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id as number }, files: [file] });
  } catch (cause) {
    const error = toExportError(cause);
    // Local files are exportable, but only once the user ticks "Allow access to
    // file URLs" for this extension. Saying so beats a generic access error.
    if (tab.url?.startsWith('file:') && error.code !== 'UNKNOWN') {
      throw new ExportError('FILE_ACCESS_DENIED', { cause });
    }
    throw error;
  }
}

async function unwrap<T>(response: Response<T>): Promise<T> {
  if (response.ok) return response.value;
  throw toExportError(new Error(response.error));
}

/* ------------------------------------------------------------------ */
/* Export orchestration                                                 */
/* ------------------------------------------------------------------ */

/**
 * Renders via CDP, falling back to the in-page canvas path when it can't.
 *
 * Element scoping differs between the two, which is why it lives here rather
 * than in the caller: the CDP path needs the page isolated first, because
 * Page.printToPDF prints whatever the document shows and has no clip region,
 * while the canvas path renders each element directly and would only be
 * confused by a page taken apart underneath it.
 */
async function render(
  tab: chrome.tabs.Tab,
  options: ExportOptions,
  metrics: PageMetrics,
  selector: string | null,
): Promise<{ base64: string; engine: ExportEngine }> {
  const tabId = tab.id as number;
  if (isCdpAvailable()) {
    try {
      if (selector) {
        await unwrap(await sendToTab(tabId, { type: 'ISOLATE_ELEMENTS', selector }));
      }
      setPhase('rendering', 'statusRendering', 'cdp');
      return { base64: await exportViaCdp({ tabId, options, metrics }), engine: 'cdp' };
    } catch (cause) {
      const error = toExportError(cause);
      if (!error.recoverable) throw error;
      // Local only — nothing about this is reported anywhere off-device.
      console.warn('[exporter] CDP path unavailable, using canvas fallback:', error.code);
      // Hand the fallback an intact page; the isolation was for the printer.
      if (selector) await sendToTab(tabId, { type: 'RESTORE_PAGE' });
    }
  }

  setPhase('rendering', 'statusRenderingFallback', 'canvas');
  await inject(tab, SCRIPTS.canvas);
  const result = await unwrap(
    await sendToTab(tabId, { type: 'RENDER_CANVAS_PDF', options, selector }),
  );
  return { base64: result.base64, engine: 'canvas' };
}

async function save(base64: string, tab: chrome.tabs.Tab): Promise<string> {
  // 4 base64 characters encode 3 bytes; close enough to catch an oversized file
  // before Chrome rejects the data: URL with an opaque message.
  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > MAX_DOWNLOAD_BYTES) throw new ExportError('TOO_LARGE');

  const filename = buildFilename({ title: tab.title, url: tab.url, extension: 'pdf' });
  setState({ phase: 'saving', message: t('statusSaving'), filename });

  let downloadId: number;
  try {
    downloadId = await chrome.downloads.download({
      url: `data:application/pdf;base64,${base64}`,
      filename,
      // The native save dialog is what lets the user rename before saving
      // (01-requirements.md §2, "Output naming").
      saveAs: true,
    });
  } catch (cause) {
    // With saveAs, download() does not settle until the user answers the native
    // dialog — so dismissing it lands here, and "nothing was written" is a very
    // different thing to tell someone than "Chrome could not save the file".
    const text = (cause instanceof Error ? cause.message : String(cause)).toLowerCase();
    const cancelled = text.includes('cancel') || text.includes('user_canceled');
    throw new ExportError(cancelled ? 'DOWNLOAD_CANCELLED' : 'DOWNLOAD_FAILED', { cause });
  }

  await settled(downloadId);
  return filename;
}

/** Resolves when the download finishes, rejects with a specific code if not. */
function settled(downloadId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete') {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve();
      } else if (delta.state.current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(onChanged);
        // "USER_CANCELED" is the user closing the save dialog, not a failure.
        const reason = delta.error?.current ?? '';
        reject(new ExportError(reason.includes('USER_CANCELED') ? 'DOWNLOAD_CANCELLED' : 'DOWNLOAD_FAILED'));
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

async function runExport(
  tab: chrome.tabs.Tab,
  options: ExportOptions,
  selector: string | null,
): Promise<void> {
  const tabId = tab.id as number;
  let mutatedPage = false;
  try {
    setPhase('preparing', 'statusPreparing', null);
    await inject(tab, SCRIPTS.readiness);
    const metrics = await unwrap(
      await sendToTab(tabId, { type: 'WAIT_FOR_READY', timeoutMs: READINESS_TIMEOUT_MS }),
    );

    if (!options.usePagePrintStyles) {
      mutatedPage = true;
      await unwrap(await sendToTab(tabId, { type: 'STRIP_PRINT_STYLES', strip: true }));
    }
    // render() isolates the page for the CDP path, so from here on it has to be
    // put back either way.
    if (selector) mutatedPage = true;

    const { base64, engine } = await render(tab, options, metrics, selector);

    // Put the page back before the save dialog appears, so the user is never
    // left looking at a page we took apart.
    if (mutatedPage) {
      mutatedPage = false;
      await sendToTab(tabId, { type: 'RESTORE_PAGE' });
    }

    const filename = await save(base64, { ...tab, title: tab.title ?? metrics.title });
    setState({
      phase: 'success',
      engine,
      message:
        elementCount > 0
          ? t('statusSuccessElements', [filename, String(elementCount)])
          : t('statusSuccess', [filename]),
      errorCode: null,
      filename,
    });
  } catch (cause) {
    setError(toExportError(cause).code);
  } finally {
    if (mutatedPage) await sendToTab(tabId, { type: 'RESTORE_PAGE' });
    await clearSelectionMarkers(tabId);
    await chrome.storage.session.remove(PENDING_KEY);
  }
}

async function clearSelectionMarkers(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [SELECTED_ATTR],
      func: (attr: string) => {
        for (const node of Array.from(document.querySelectorAll(`[${attr}]`))) {
          node.removeAttribute(attr);
        }
      },
    });
  } catch {
    /* The tab may have navigated or closed; nothing to clean up in that case. */
  }
}

/* ------------------------------------------------------------------ */
/* Entry points                                                         */
/* ------------------------------------------------------------------ */

async function startPageExport(options?: ExportOptions): Promise<ExportState> {
  elementCount = 0;
  try {
    const tab = await activeTab();
    await runExport(tab, options ?? (await loadOptions()), null);
  } catch (cause) {
    setError(toExportError(cause).code);
  }
  return state;
}

async function startElementExport(options?: ExportOptions): Promise<ExportState> {
  try {
    const tab = await activeTab();
    const tabId = tab.id as number;
    const resolved = options ?? (await loadOptions());
    const pending: PendingElementExport = { tabId, options: resolved, startedAt: Date.now() };
    await chrome.storage.session.set({ [PENDING_KEY]: pending });

    setPhase('picking', 'statusPicking', null);
    await inject(tab, SCRIPTS.picker);
    await unwrap(await sendToTab(tabId, { type: 'START_PICKER' }));
  } catch (cause) {
    await chrome.storage.session.remove(PENDING_KEY);
    setError(toExportError(cause).code);
  }
  return state;
}

/** Continues an element export after the picker reports a selection. */
async function onPickerResult(tabId: number, selector: string, count: number): Promise<void> {
  const stored = await chrome.storage.session.get(PENDING_KEY);
  const pending = stored[PENDING_KEY] as PendingElementExport | undefined;
  if (!pending || pending.tabId !== tabId) return;

  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab) {
    setError('NO_ACTIVE_TAB');
    return;
  }
  elementCount = count;
  await runExport(tab, pending.options, selector);
}

async function cancel(): Promise<ExportState> {
  const stored = await chrome.storage.session.get(PENDING_KEY);
  const pending = stored[PENDING_KEY] as PendingElementExport | undefined;
  if (pending) {
    await sendToTab(pending.tabId, { type: 'STOP_PICKER' });
    await chrome.storage.session.remove(PENDING_KEY);
  }
  return setState({ phase: 'idle', engine: null, message: '', errorCode: null, filename: null });
}

/* ------------------------------------------------------------------ */
/* Wiring                                                               */
/* ------------------------------------------------------------------ */

function registerContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_EXPORT_PAGE,
      title: t('menuExportPage'),
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_EXPORT_SELECTION,
      title: t('menuExportSelection'),
      contexts: ['page'],
    });
  });
}

chrome.runtime.onInstalled.addListener(registerContextMenus);
chrome.runtime.onStartup.addListener(registerContextMenus);

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === CONTEXT_MENU_EXPORT_PAGE) void startPageExport();
  if (info.menuItemId === CONTEXT_MENU_EXPORT_SELECTION) void startElementExport();
});

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  // Only this extension's own pages and content scripts may command the worker.
  if (sender.id !== chrome.runtime.id) return false;
  if (!isMessage(raw)) return false;
  const message = raw as AnyMessage;

  switch (message.type) {
    case 'GET_STATE':
      sendResponse(ok(state));
      return false;
    case 'EXPORT': {
      const run = message.scope === 'element' ? startElementExport : startPageExport;
      run(message.options).then(
        (next) => sendResponse(ok(next)),
        (cause: unknown) => sendResponse(err(String(cause))),
      );
      return true;
    }
    case 'CANCEL':
      cancel().then(
        (next) => sendResponse(ok(next)),
        (cause: unknown) => sendResponse(err(String(cause))),
      );
      return true;
    case 'PICKER_RESULT': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) {
        sendResponse(err('picker result arrived without a tab'));
        return false;
      }
      if (message.rects.length === 0) {
        sendResponse(ok(null));
        setError('NOTHING_SELECTED');
        return false;
      }
      sendResponse(ok(null));
      void onPickerResult(tabId, message.selector, message.rects.length);
      return false;
    }
    case 'PICKER_CANCELLED':
      sendResponse(ok(null));
      void chrome.storage.session.remove(PENDING_KEY);
      setError('PICKER_CANCELLED');
      return false;
    default:
      return false;
  }
});
