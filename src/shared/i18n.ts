/**
 * Applies _locales strings to a page. Every user-facing string in the popup and
 * options page is a `data-i18n` key here — the markup only carries English as a
 * readable fallback for anyone reading the source (01-requirements.md §3).
 */
export function localizeDocument(root: ParentNode = document): void {
  for (const node of Array.from(root.querySelectorAll<HTMLElement>('[data-i18n]'))) {
    const key = node.dataset.i18n;
    if (!key) continue;
    const value = chrome.i18n.getMessage(key);
    if (value) node.textContent = value;
  }
  for (const node of Array.from(root.querySelectorAll<HTMLElement>('[data-i18n-label]'))) {
    const key = node.dataset.i18nLabel;
    if (!key) continue;
    const value = chrome.i18n.getMessage(key);
    if (value) node.setAttribute('aria-label', value);
  }
}

export const t = (key: string, substitutions?: string[]): string =>
  chrome.i18n.getMessage(key, substitutions) || key;
