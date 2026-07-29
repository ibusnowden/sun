import { sanitizeTerminalText, tone, truncate, visibleWidth } from "./theme.ts";

/**
 * The full-screen pager, as `design/codex-ui.md` records it. Sun's transcript
 * is scrollback the user scrolls with their own terminal, so this is the one
 * surface that owns the screen: it takes the alternate buffer, paints a fixed
 * viewport over a body it scrolls itself, and hands the screen back on exit.
 *
 * Everything here is pure. The terminal only supplies a width, a height, and
 * an offset, which is what makes the layout testable without a tty.
 */

/** Header, rule, both hint rows, and the trailing blank line. */
const CHROME_ROWS = 5;

const HINT_KEYS = " ↑/↓ to scroll   pgup/pgdn to page   home/end to jump";
const HINT_QUIT = " q to quit";

/** Rows past the end of the content, the way vim and less mark them. */
const FILLER = "~";

export const PAGER_EMPTY = "No changes detected.";

export interface PagerState {
  title: string;
  /** The unwrapped patch, kept so a resize can re-break every long line. */
  source: string;
  /** Wrapped, painted body rows. One entry is one screen row. */
  rows: string[];
  /** The width `rows` was wrapped for, so scrolling never re-wraps. */
  wrappedWidth: number;
  offset: number;
}

/**
 * Re-wrap only when the width actually changed. Scrolling a large diff would
 * otherwise re-break every line in the patch on each keystroke.
 */
export function refitPager(state: PagerState, width: number): void {
  if (state.wrappedWidth === width) return;
  state.rows = wrapPatch(state.source, width);
  state.wrappedWidth = width;
}

export type PagerMove =
  | "up"
  | "down"
  | "page-up"
  | "page-down"
  | "home"
  | "end";

export function pagerBodyHeight(rows: number): number {
  return Math.max(1, rows - CHROME_ROWS);
}

export function pagerMaxOffset(total: number, height: number): number {
  return Math.max(0, total - height);
}

/**
 * 0% at the top, 100% once the final row is on screen. A body that already
 * fits has nowhere to go, so it reads 100% rather than 0%.
 */
export function pagerPercent(offset: number, maxOffset: number): number {
  if (maxOffset <= 0) return 100;
  const clamped = Math.min(Math.max(0, offset), maxOffset);
  return Math.round((clamped / maxOffset) * 100);
}

export function pagerScroll(
  state: PagerState,
  move: PagerMove,
  rows: number,
): number {
  const height = pagerBodyHeight(rows);
  const max = pagerMaxOffset(state.rows.length, height);
  const deltas: Record<PagerMove, number> = {
    up: -1,
    down: 1,
    "page-up": -height,
    "page-down": height,
    home: -Infinity,
    end: Infinity,
  };
  const next = state.offset + deltas[move];
  return Math.min(Math.max(0, next), max);
}

/** Exactly `rows` lines, ready to write to the alternate screen. */
export function renderPager(
  state: PagerState,
  width: number,
  rows: number,
): string[] {
  const height = pagerBodyHeight(rows);
  const max = pagerMaxOffset(state.rows.length, height);
  const offset = Math.min(Math.max(0, state.offset), max);

  const lines = [pagerTitle(state.title, width)];
  for (let index = 0; index < height; index += 1) {
    lines.push(state.rows[offset + index] ?? FILLER);
  }
  // The chrome is fixed text, so a terminal narrower than the hints is the one
  // case it has to be clipped rather than allowed to wrap into the body.
  lines.push(truncate(tone.muted(scrollRule(pagerPercent(offset, max), width)), width));
  lines.push(truncate(tone.muted(HINT_KEYS), width));
  lines.push(truncate(tone.muted(HINT_QUIT), width));
  lines.push("");
  return lines;
}

/** `/ D I F F / / / …`, letter-spaced and filled to the full width. */
export function pagerTitle(title: string, width: number): string {
  const safeWidth = Math.max(1, width);
  let line = `/ ${[...title.toUpperCase()].join(" ")} `;
  while (line.length < safeWidth) line += "/ ";
  return tone.muted(line.slice(0, safeWidth));
}

function scrollRule(percent: number, width: number): string {
  const tail = ` ${percent}% ─`;
  return `${"─".repeat(Math.max(0, width - tail.length))}${tail}`;
}

/**
 * Split a patch into painted screen rows.
 *
 * The body is the raw patch — `index`, `---`/`+++`, and `@@` all survive,
 * where the transcript's inline preview drops them. A reader who opened the
 * full diff asked for the file's coordinates, not a summary of them.
 */
export function wrapPatch(patch: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const text = sanitizeTerminalText(patch).replace(/\r/g, "");
  if (!text.trim()) return [PAGER_EMPTY];

  const rows: string[] = [];
  for (const raw of text.replace(/\n$/, "").split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    const paint = painterFor(line);
    if (!line) {
      rows.push("");
      continue;
    }
    for (const piece of hardWrap(line, safeWidth)) rows.push(paint(piece));
  }
  return rows;
}

/**
 * Codex breaks at the column, not at a word boundary — a 292-column addition
 * split at exactly 110, mid-token. Diff bodies are code, and word wrapping
 * would shift the very columns the reader is comparing.
 */
function hardWrap(line: string, width: number): string[] {
  if (visibleWidth(line) <= width) return [line];
  const pieces: string[] = [];
  let current = "";
  let printed = 0;
  for (const character of line) {
    const cost = visibleWidth(character);
    if (printed + cost > width) {
      pieces.push(current.replace(/\s+$/, ""));
      current = "";
      printed = 0;
    }
    current += character;
    printed += cost;
  }
  if (current) pieces.push(current.replace(/\s+$/, ""));
  return pieces;
}

/**
 * Order matters: `---` and `+++` are file headers, and testing them after the
 * one-character `-`/`+` cases would paint them as a deletion and an addition.
 */
function painterFor(line: string): (value: string) => string {
  if (/^(diff --git |index |--- |\+\+\+ |new file |deleted file |rename |similarity |old mode |new mode )/.test(line)) {
    return tone.heading;
  }
  if (line.startsWith("@@")) return tone.info;
  if (line.startsWith("-")) return tone.removed;
  if (line.startsWith("+")) return tone.added;
  return (value) => value;
}
