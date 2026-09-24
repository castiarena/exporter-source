/**
 * Names for the position an element will take in the exported PDF.
 *
 * The picker labels elements by where they land — "First", "Second" — rather
 * than by what they are in the markup. A tag-and-class label (`div#main.card`)
 * describes the page's source, which is not what someone choosing what to
 * export is thinking about; the position is.
 *
 * Only the first ten have names. Past that a name stops helping — nobody reads
 * "Twenty-seventh" and knows where it sits — so the position is shown as a
 * number instead. This lives apart from the picker because the overlay is inside
 * a closed shadow root and cannot be inspected from a test; the mapping can.
 */

/** Positions with a written-out name. Beyond this, the number is clearer. */
export const NAMED_ORDINAL_LIMIT = 10;

export interface OrdinalMessage {
  /** Key into _locales/en/messages.json. */
  readonly key: string;
  readonly substitutions?: readonly string[];
}

/**
 * Maps a zero-based position to the message describing it.
 *
 * Anything below zero is treated as the first position: a caller with a bad
 * index should still get a sensible label rather than a raw key on screen.
 */
export function ordinalMessage(index: number): OrdinalMessage {
  const position = Math.max(1, Math.floor(index) + 1);
  if (position <= NAMED_ORDINAL_LIMIT) return { key: `ordinal${position}` };
  return { key: 'ordinalNumbered', substitutions: [String(position)] };
}
