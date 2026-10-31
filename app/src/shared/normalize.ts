/**
 * The pinned normalisation under which a quoted fragment is searched in a page text (C11, research R13,
 * contracts/type-schema.md). It is applied to both sides before the search, so differences that are not evidence
 * (an apostrophe variant, a non-breaking space, a hyphenated line break) do not make a true quote fail, while a
 * different word still does: a near match is not evidence (constitution VI).
 */

/** Apostrophe variants that become the plain apostrophe: right and left single quotation marks, the modifier letter apostrophe and the grave accent. */
const apostropheVariants = new Set(['’', '‘', 'ʼ', '`']);

/** Non-breaking, figure, narrow no-break, thin and hair spaces: all become an ordinary space. */
const spaceVariants = new Set([' ', ' ', ' ', ' ', ' ']);

/** Hyphen-minus and the Unicode hyphen: the characters a word is broken with at the end of a line. */
const hyphens = new Set(['-', '‐']);

/** Characters that end a line. */
const lineBreaks = new Set(['\n', '\r', ' ', ' ']);

/** Spaces that may sit between a hyphen and its line break, or at the start of the next line. */
const horizontalSpace = new Set([' ', '\t']);

/**
 * A text after normalisation together with the map back to the original: for every UTF-16 unit of `text`, the range of
 * the original string it came from. Offsets of a match are computed on `text` and mapped back, so the stored page text
 * stays exactly as the parser wrote it (FR-018).
 */
export type Normalized = {
  text: string;
  starts: number[];
  ends: number[];
};

/** One character of the output with the original range it stands for. */
type Unit = {
  character: string;
  from: number;
  to: number;
};

/** Length in UTF-16 units of the code point at `index`. */
function codePointLength(text: string, index: number): number {
  return (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
}

/**
 * First phase: groups the original into clusters of a base character and its combining marks, puts each cluster in
 * NFC, and applies the one-to-one replacements. Every character a cluster yields keeps the cluster's whole original
 * range, because composing can merge several original characters into one.
 */
function toUnits(text: string): Unit[] {
  const units: Unit[] = [];
  let index = 0;
  while (index < text.length) {
    const from = index;
    index += codePointLength(text, index);
    while (index < text.length && /^\p{M}$/u.test(text.slice(index, index + codePointLength(text, index)))) {
      index += codePointLength(text, index);
    }
    for (const character of text.slice(from, index).normalize('NFC')) {
      if (character === '­') {
        continue;
      }
      const replaced = apostropheVariants.has(character) ? "'" : spaceVariants.has(character) ? ' ' : character;
      units.push({ character: replaced, from, to: index });
    }
  }
  return units;
}

/** True for a character that is a letter in any script. */
function isLetter(character: string): boolean {
  return /^\p{L}$/u.test(character);
}

/**
 * If the hyphen at `index` ends a line inside a word, returns the index of the first unit after the break and the
 * indentation that follows it; otherwise `null`. A hyphen counts only after a letter, so a dash standing for an empty
 * value at the end of a line is left alone.
 */
function hyphenatedBreakEnd(units: Unit[], index: number, previous: Unit | undefined): number | null {
  if (previous === undefined || !isLetter(previous.character)) {
    return null;
  }
  let cursor = index + 1;
  while (cursor < units.length && horizontalSpace.has(units[cursor]?.character ?? '')) {
    cursor += 1;
  }
  if (!lineBreaks.has(units[cursor]?.character ?? '')) {
    return null;
  }
  if (units[cursor]?.character === '\r' && units[cursor + 1]?.character === '\n') {
    cursor += 1;
  }
  cursor += 1;
  while (cursor < units.length && horizontalSpace.has(units[cursor]?.character ?? '')) {
    cursor += 1;
  }
  // A blank line is a paragraph break, not a word broken across two lines.
  return lineBreaks.has(units[cursor]?.character ?? '') ? null : cursor;
}

/**
 * Normalises a text: Unicode NFC; apostrophe variants to `'`; non-breaking and thin spaces to a space; a run of
 * whitespace to one space; soft hyphens removed; a hyphen followed by a line break inside a word joins the word. The
 * result carries the map back to the original.
 */
export function normalizeText(original: string): Normalized {
  const units = toUnits(original);
  const kept: Unit[] = [];
  let index = 0;
  while (index < units.length) {
    const unit = units[index];
    if (unit === undefined) {
      break;
    }
    if (hyphens.has(unit.character)) {
      const next = hyphenatedBreakEnd(units, index, kept[kept.length - 1]);
      if (next !== null) {
        index = next;
        continue;
      }
    }
    if (/^\s$/u.test(unit.character)) {
      const last = kept[kept.length - 1];
      if (last !== undefined && last.character === ' ') {
        last.to = unit.to;
      } else {
        kept.push({ character: ' ', from: unit.from, to: unit.to });
      }
    } else {
      kept.push({ ...unit });
    }
    index += 1;
  }

  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (const unit of kept) {
    text += unit.character;
    for (let part = 0; part < unit.character.length; part += 1) {
      starts.push(unit.from);
      ends.push(unit.to);
    }
  }
  return { text, starts, ends };
}

/** The normalised form of a quoted fragment, trimmed: what is searched in the normalised page text. */
export function normalizeFragment(fragment: string): string {
  return normalizeText(fragment).text.trim();
}

/**
 * Maps a range of the normalised text, `start` included and `end` excluded, back to the original text. The result is the
 * smallest original range that covers every character of the match.
 */
export function originalRange(normalized: Normalized, start: number, end: number): { start: number; end: number } {
  const first = normalized.starts[start];
  const last = normalized.ends[end - 1];
  if (start < 0 || end <= start || first === undefined || last === undefined) {
    throw new RangeError(`The range ${start}-${end} is outside the normalised text`);
  }
  return { start: first, end: last };
}
