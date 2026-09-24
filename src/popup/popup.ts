/**
 * Popup UI. It holds no export logic of its own: it reads defaults from
 * storage, sends a typed EXPORT command, and renders whatever ExportState the
 * background worker broadcasts back.
 *
 * The popup closes the moment the browser's save dialog opens, so the status
 * area is re-synced from the worker on every open rather than kept in memory.
 */
import { localizeDocument, t } from '../shared/i18n';
import { DEFAULT_OPTIONS, PAPER_SIZES, STORAGE_KEY_OPTIONS } from '../shared/constants';
import { isMessage, sendToBackground } from '../shared/messaging';
import type { BroadcastMessage } from '../shared/messaging';
import type { ExportOptions, ExportState, PaperSizeId } from '../shared/types';

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
};

const exportPageButton = $<HTMLButtonElement>('export-page');
const exportElementButton = $<HTMLButtonElement>('export-element');
const cancelButton = $<HTMLButtonElement>('cancel');
const optionsButton = $<HTMLButtonElement>('open-options');
const paperSelect = $<HTMLSelectElement>('paper-size');
const backgroundCheck = $<HTMLInputElement>('print-background');
const printStylesCheck = $<HTMLInputElement>('use-page-print-styles');
const status = $<HTMLParagraphElement>('status');
const engineNote = $<HTMLParagraphElement>('engine-note');

const BUSY_PHASES = new Set(['preparing', 'picking', 'rendering', 'saving']);

function currentOptions(): ExportOptions {
  return {
    format: 'pdf',
    paperSize: paperSelect.value as PaperSizeId,
    printBackground: backgroundCheck.checked,
    usePagePrintStyles: printStylesCheck.checked,
  };
}

async function persistOptions(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY_OPTIONS]: currentOptions() });
}

function renderPaperSizes(): void {
  paperSelect.replaceChildren(
    ...PAPER_SIZES.map((size) => {
      const option = document.createElement('option');
      option.value = size.id;
      option.textContent = t(size.labelKey);
      return option;
    }),
  );
}

function applyOptions(options: ExportOptions): void {
  paperSelect.value = options.paperSize;
  backgroundCheck.checked = options.printBackground;
  printStylesCheck.checked = options.usePagePrintStyles;
}

function renderState(state: ExportState): void {
  const busy = BUSY_PHASES.has(state.phase);

  status.textContent = state.phase === 'idle' ? t('statusIdle') : state.message;
  status.dataset.phase = state.phase;
  status.dataset.busy = String(busy);

  exportPageButton.disabled = busy;
  exportElementButton.disabled = busy;
  paperSelect.disabled = busy;
  backgroundCheck.disabled = busy;
  printStylesCheck.disabled = busy;
  cancelButton.hidden = state.phase !== 'picking';

  // Only worth surfacing once something was actually produced: it tells the
  // user why the text in this particular PDF may not be selectable.
  const showEngine = state.phase === 'success' && state.engine !== null;
  engineNote.hidden = !showEngine;
  engineNote.textContent = showEngine
    ? t(state.engine === 'cdp' ? 'engineCdp' : 'engineCanvas')
    : '';
}

async function refresh(): Promise<void> {
  const response = await sendToBackground({ type: 'GET_STATE' });
  if (response.ok) renderState(response.value);
}

async function startExport(scope: 'page' | 'element'): Promise<void> {
  await persistOptions();
  const response = await sendToBackground({ type: 'EXPORT', scope, options: currentOptions() });
  if (response.ok) renderState(response.value);
}

async function init(): Promise<void> {
  localizeDocument();
  renderPaperSizes();

  const stored = await chrome.storage.local.get(STORAGE_KEY_OPTIONS);
  applyOptions({
    ...DEFAULT_OPTIONS,
    ...((stored[STORAGE_KEY_OPTIONS] as Partial<ExportOptions> | undefined) ?? {}),
  });

  exportPageButton.addEventListener('click', () => void startExport('page'));
  exportElementButton.addEventListener('click', () => void startExport('element'));
  cancelButton.addEventListener('click', () => {
    void sendToBackground({ type: 'CANCEL' }).then((response) => {
      if (response.ok) renderState(response.value);
    });
  });
  optionsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());

  for (const input of [paperSelect, backgroundCheck, printStylesCheck]) {
    input.addEventListener('change', () => void persistOptions());
  }

  chrome.runtime.onMessage.addListener((raw) => {
    if (!isMessage(raw)) return;
    const message = raw as BroadcastMessage;
    if (message.type === 'STATE_CHANGED') renderState(message.state);
  });

  await refresh();
}

void init();
