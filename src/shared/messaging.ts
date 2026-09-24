/**
 * The one typed contract every chrome.runtime message in this extension goes
 * through. Popup, options page, content scripts and the service worker all
 * import from here so a message shape cannot drift between them.
 */
import type {
  ElementRect,
  ExportOptions,
  ExportScope,
  ExportState,
  PageMetrics,
} from './types';

/** popup / options / context menu -> background */
export type CommandMessage =
  | { readonly type: 'EXPORT'; readonly scope: ExportScope['kind']; readonly options: ExportOptions }
  | { readonly type: 'CANCEL' }
  | { readonly type: 'GET_STATE' };

/** content script -> background */
export type ContentMessage =
  | {
      readonly type: 'PICKER_RESULT';
      /** Matches every picked element at once — see SELECTED_SELECTOR. */
      readonly selector: string;
      /** One per picked element, in document order. */
      readonly rects: readonly ElementRect[];
    }
  | { readonly type: 'PICKER_CANCELLED' };

/** background -> content script (sent to a specific tab) */
export type TabMessage =
  | { readonly type: 'START_PICKER' }
  | { readonly type: 'STOP_PICKER' }
  | { readonly type: 'WAIT_FOR_READY'; readonly timeoutMs: number }
  | { readonly type: 'ISOLATE_ELEMENTS'; readonly selector: string }
  | { readonly type: 'RESTORE_PAGE' }
  | { readonly type: 'STRIP_PRINT_STYLES'; readonly strip: boolean }
  | {
      readonly type: 'RENDER_CANVAS_PDF';
      readonly options: ExportOptions;
      readonly selector: string | null;
    };

/** background -> popup (broadcast, best-effort: nobody may be listening) */
export type BroadcastMessage = { readonly type: 'STATE_CHANGED'; readonly state: ExportState };

export type AnyMessage = CommandMessage | ContentMessage | TabMessage | BroadcastMessage;

/** Every response is this envelope, so callers never guess at error shapes. */
export type Response<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export interface ResponseMap {
  EXPORT: ExportState;
  CANCEL: ExportState;
  GET_STATE: ExportState;
  PICKER_RESULT: null;
  PICKER_CANCELLED: null;
  START_PICKER: null;
  STOP_PICKER: null;
  WAIT_FOR_READY: PageMetrics;
  ISOLATE_ELEMENTS: { readonly count: number };
  RESTORE_PAGE: null;
  STRIP_PRINT_STYLES: null;
  RENDER_CANVAS_PDF: { readonly base64: string };
  STATE_CHANGED: null;
}

export const ok = <T>(value: T): Response<T> => ({ ok: true, value });
export const err = (error: string): Response<never> => ({ ok: false, error });

/** Narrow an untrusted `unknown` off the wire into one of our message types. */
export function isMessage(value: unknown): value is AnyMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/**
 * chrome.runtime.sendMessage, but promise-shaped, and it never throws for the
 * ordinary "no receiver" case — a closed popup is not an error.
 */
export async function sendToBackground<M extends CommandMessage | ContentMessage>(
  message: M,
): Promise<Response<ResponseMap[M['type']]>> {
  try {
    const response = (await chrome.runtime.sendMessage(message)) as
      | Response<ResponseMap[M['type']]>
      | undefined;
    return response ?? err('No response from the background service worker.');
  } catch (cause) {
    return err(cause instanceof Error ? cause.message : String(cause));
  }
}

export async function sendToTab<M extends TabMessage>(
  tabId: number,
  message: M,
): Promise<Response<ResponseMap[M['type']]>> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, message)) as
      | Response<ResponseMap[M['type']]>
      | undefined;
    return response ?? err('No response from the page.');
  } catch (cause) {
    return err(cause instanceof Error ? cause.message : String(cause));
  }
}

/** Fire-and-forget broadcast; a closed popup rejecting is expected and ignored. */
export function broadcast(message: BroadcastMessage): void {
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}
