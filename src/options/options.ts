/**
 * Options page: the defaults every new export starts from.
 *
 * Persisted with chrome.storage.local, deliberately not `.sync` — syncing would
 * push a user's settings through Google's servers, which contradicts the "no
 * data leaves the device" posture in 01-requirements.md §4.
 */
import { localizeDocument, t } from '../shared/i18n';
import { DEFAULT_OPTIONS, PAPER_SIZES, STORAGE_KEY_OPTIONS } from '../shared/constants';
import type { ExportOptions, PaperSizeId } from '../shared/types';

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
};

const paperSelect = $<HTMLSelectElement>('paper-size');
const backgroundCheck = $<HTMLInputElement>('print-background');
const printStylesCheck = $<HTMLInputElement>('use-page-print-styles');
const resetButton = $<HTMLButtonElement>('reset');
const savedNote = $<HTMLParagraphElement>('saved');

let savedNoteTimer: ReturnType<typeof setTimeout> | undefined;

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

function read(): ExportOptions {
  return {
    format: 'pdf',
    paperSize: paperSelect.value as PaperSizeId,
    printBackground: backgroundCheck.checked,
    usePagePrintStyles: printStylesCheck.checked,
  };
}

function apply(options: ExportOptions): void {
  paperSelect.value = options.paperSize;
  backgroundCheck.checked = options.printBackground;
  printStylesCheck.checked = options.usePagePrintStyles;
}

function announceSaved(): void {
  savedNote.textContent = t('optionsSaved');
  clearTimeout(savedNoteTimer);
  savedNoteTimer = setTimeout(() => {
    savedNote.textContent = '';
  }, 2000);
}

async function save(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY_OPTIONS]: read() });
  announceSaved();
}

async function init(): Promise<void> {
  localizeDocument();
  renderPaperSizes();

  const stored = await chrome.storage.local.get(STORAGE_KEY_OPTIONS);
  apply({
    ...DEFAULT_OPTIONS,
    ...((stored[STORAGE_KEY_OPTIONS] as Partial<ExportOptions> | undefined) ?? {}),
  });

  for (const input of [paperSelect, backgroundCheck, printStylesCheck]) {
    input.addEventListener('change', () => void save());
  }
  resetButton.addEventListener('click', () => {
    apply(DEFAULT_OPTIONS);
    void save();
  });
}

void init();
