/**
 * gutter — every transcript line starts with a 2-column glyph, and all content
 * aligns on column 2. Continuation lines indent to match, so the glyph column
 * stays a clean vertical spine no matter how much text wraps.
 */

import { displayWidth, wrapLine } from "./live-region.js";

export const GUTTER_W = 2;

/** The whole glyph alphabet. Resist adding more. */
export const G = {
  user: "❯",
  assistant: "⏺",
  ok: "✓",
  fail: "✗",
  run: "◐",
  warn: "!",
  cont: "│",
  cut: "⎯",
  none: " ",
} as const;

/** Four colours, and that is the entire budget. */
export const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  accent: (s: string) => `\x1b[36m${s}\x1b[39m`,
  ok: (s: string) => `\x1b[32m${s}\x1b[39m`,
  fail: (s: string) => `\x1b[31m${s}\x1b[39m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[39m`,
  plain: (s: string) => s,
};

const SPINNER = ["◐", "◓", "◑", "◒"];
export const spinner = (tick: number) => SPINNER[tick % SPINNER.length];

/**
 * Word-aware wrap. Falls back to hard wrapping for tokens longer than the
 * available width (URLs, paths, base64) so nothing ever overflows.
 */
export function wrapWords(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const rows: string[] = [];
  let cur = "";
  let curW = 0;

  for (const word of text.split(/(\s+)/)) {
    if (!word) continue;
    const w = displayWidth(word);

    if (/^\s+$/.test(word)) {
      if (curW && curW + w <= width) {
        cur += word;
        curW += w;
      }
      continue;
    }

    if (w > width) {
      if (cur) {
        rows.push(cur);
        cur = "";
        curW = 0;
      }
      const hard = wrapLine(word, width);
      rows.push(...hard.slice(0, -1));
      cur = hard[hard.length - 1];
      curW = displayWidth(cur);
      continue;
    }

    if (curW + w > width) {
      rows.push(cur);
      cur = word;
      curW = w;
    } else {
      cur += word;
      curW += w;
    }
  }

  if (cur || !rows.length) rows.push(cur);
  return rows;
}

export interface GutterOptions {
  /** Colour applied to the glyph only. Content keeps its own styling. */
  glyphColor?: (s: string) => string;
  /** Glyph for wrapped continuation rows. Defaults to blank. */
  contGlyph?: string;
}

/** Render one logical entry as gutter-aligned physical rows. */
export function gutter(
  glyph: string,
  text: string,
  width: number,
  opts: GutterOptions = {},
): string[] {
  const inner = Math.max(1, width - GUTTER_W);
  const color = opts.glyphColor ?? C.plain;
  const cont = opts.contGlyph ?? " ";
  const pad = (g: string) => g + " ".repeat(Math.max(0, GUTTER_W - displayWidth(g)));

  return text
    .split("\n")
    .flatMap((line) => wrapWords(line, inner))
    .map((row, i) => (i === 0 ? color(pad(glyph)) : pad(cont)) + row);
}

/**
 * Tool calls are three columns, never prose: fixed-width name, flexible
 * target, right-aligned metadata. The aligned right edge is what makes a long
 * transcript scannable.
 */
export function toolLine(
  glyph: string,
  name: string,
  target: string,
  meta: string,
  width: number,
  glyphColor: (s: string) => string = C.plain,
): string {
  const NAME_W = 9;
  const metaW = displayWidth(meta);
  const avail = Math.max(4, width - GUTTER_W - NAME_W - metaW - 2);

  let t = target;
  if (displayWidth(t) > avail) {
    // Truncate from the left — the tail of a path is the informative part.
    while (displayWidth(t) > avail - 1 && t.length) t = t.slice(1);
    t = "…" + t;
  }

  const gap = " ".repeat(
    Math.max(1, width - GUTTER_W - NAME_W - displayWidth(t) - metaW),
  );
  const paddedName = name + " ".repeat(Math.max(1, NAME_W - displayWidth(name)));

  return glyphColor(glyph) + " " + paddedName + C.dim(t) + gap + C.dim(meta);
}
