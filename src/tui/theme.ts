const ESCAPE = "\x1b[";

export const control = {
  hideCursor: `${ESCAPE}?25l`,
  showCursor: `${ESCAPE}?25h`,
  eraseDown: `${ESCAPE}0J`,
  eraseLine: `${ESCAPE}2K`,
  lineStart: "\r",
  clearScreen: `${ESCAPE}2J${ESCAPE}H`,
  // Synchronized output: terminals that support it composite the whole live
  // frame at once instead of showing it mid-redraw. Others ignore it.
  syncStart: `${ESCAPE}?2026h`,
  syncEnd: `${ESCAPE}?2026l`,
} as const;

export function cursorUp(rows: number): string {
  return rows > 0 ? `${ESCAPE}${rows}A` : "";
}

export function cursorToColumn(column: number): string {
  return `${ESCAPE}${Math.max(1, column)}G`;
}

const CODES = {
  reset: 0,
  bold: 1,
  dim: 2,
  italic: 3,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 90,
} as const;

export type ColorName = keyof typeof CODES;

let colorEnabled = detectColor();

function detectColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

export function paint(value: string, ...names: ColorName[]): string {
  if (!colorEnabled || !value || names.length === 0) return value;
  const prefix = names.map((name) => `${ESCAPE}${CODES[name]}m`).join("");
  return `${prefix}${value}${ESCAPE}${CODES.reset}m`;
}

/** Sun's semantic palette. Every renderer paints through these names. */
export const tone = {
  brand: (value: string) => paint(value, "yellow", "bold"),
  heading: (value: string) => paint(value, "bold"),
  muted: (value: string) => paint(value, "dim"),
  detail: (value: string) => paint(value, "gray"),
  running: (value: string) => paint(value, "cyan"),
  ok: (value: string) => paint(value, "green"),
  failed: (value: string) => paint(value, "red"),
  warn: (value: string) => paint(value, "yellow"),
  info: (value: string) => paint(value, "cyan"),
  added: (value: string) => paint(value, "green"),
  removed: (value: string) => paint(value, "red"),
  selected: (value: string) => paint(value, "cyan", "bold"),
} as const;

/**
 * One bullet per event, two connectors for detail. See `design/codex-ui.md`:
 * the interface carries depth with indentation, not with a marker vocabulary,
 * so this set is deliberately small.
 */
export const glyph = {
  /** Opens a user message and marks the selected row in a menu. */
  user: "›",
  /** Opens every agent event: prose, command, edit, notice. */
  bullet: "•",
  /** First line of a command's output. */
  corner: "└",
  /** Continuation of a command that did not fit on one line. */
  continuation: "│",
  ok: "✓",
  failed: "✗",
  warn: "!",
  ellipsis: "…",
} as const;

const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;
const SAFE_SGR = new Set(["0", "1", "2", "3", "31", "32", "33", "34", "35", "36", "90"]);
const WIDE_PATTERN =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;

export function stripAnsi(value: string): string {
  return sanitizeTerminalText(value);
}

export function visibleWidth(value: string): number {
  let width = 0;
  for (const character of stripAnsi(value)) {
    width += WIDE_PATTERN.test(character) ? 2 : 1;
  }
  return width;
}

/** Truncate to a printable width, preserving any active color sequences. */
export function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  const safeValue = sanitizeTerminalText(value, { allowSafeSgr: true });
  if (visibleWidth(safeValue) <= width) return safeValue;
  let result = "";
  let printed = 0;
  let index = 0;
  const limit = width - 1;
  while (index < safeValue.length) {
    const escape = matchEscape(safeValue, index);
    if (escape) {
      result += escape;
      index += escape.length;
      continue;
    }
    const character = String.fromCodePoint(safeValue.codePointAt(index) ?? 32);
    const cost = WIDE_PATTERN.test(character) ? 2 : 1;
    if (printed + cost > limit) break;
    result += character;
    printed += cost;
    index += character.length;
  }
  return `${result}${colorEnabled ? `${ESCAPE}0m` : ""}${glyph.ellipsis}`;
}

function matchEscape(value: string, index: number): string | null {
  if (value[index] !== "\x1b") return null;
  ANSI_PATTERN.lastIndex = index;
  const match = ANSI_PATTERN.exec(value);
  ANSI_PATTERN.lastIndex = 0;
  return match && match.index === index ? match[0] : null;
}

export function pad(value: string, width: number): string {
  const missing = width - visibleWidth(value);
  return missing > 0 ? `${value}${" ".repeat(missing)}` : value;
}

/** Word-wrap plain text, hard-breaking words that cannot fit on one line. */
export function wrap(value: string, width: number): string[] {
  if (width <= 0) return [];
  value = sanitizeTerminalText(value);
  const lines: string[] = [];
  for (const paragraph of value.replace(/\r/g, "").split("\n")) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      if (!current) {
        current = word;
      } else if (visibleWidth(current) + 1 + visibleWidth(word) <= width) {
        current = `${current} ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
      while (visibleWidth(current) > width) {
        const piece = hardSlice(current, width);
        lines.push(piece);
        current = current.slice(piece.length);
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

/**
 * Remove terminal controls from model, tool, repository, and pasted text.
 * Renderers may explicitly preserve Sun's small SGR color palette.
 */
export function sanitizeTerminalText(
  value: string,
  options: { allowSafeSgr?: boolean } = {},
): string {
  let result = "";
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const next = value.charCodeAt(index + 1);
      if (next === 0x5b) {
        const end = controlSequenceEnd(value, index + 2);
        const sequence = value.slice(index + 2, end);
        const final = value[end] ?? "";
        if (
          options.allowSafeSgr &&
          final === "m" &&
          SAFE_SGR.has(sequence)
        ) {
          result += value.slice(index, end + 1);
        }
        index = Math.min(value.length, end + 1);
        continue;
      }
      if ([0x5d, 0x50, 0x58, 0x5e, 0x5f].includes(next)) {
        index = stringSequenceEnd(value, index + 2);
        continue;
      }
      index = Math.min(value.length, index + 2);
      continue;
    }
    if (code === 0x9b) {
      index = Math.min(value.length, controlSequenceEnd(value, index + 1) + 1);
      continue;
    }
    if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
      index = stringSequenceEnd(value, index + 1);
      continue;
    }
    if (code === 0x0a || code === 0x09) {
      result += value[index];
    } else if (code === 0x0d) {
      result += " ";
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      // Drop remaining C0/C1 controls, including BEL and backspace.
    } else {
      const character = String.fromCodePoint(value.codePointAt(index) ?? 32);
      result += character;
      index += character.length;
      continue;
    }
    index += 1;
  }
  return result;
}

function controlSequenceEnd(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return value.length;
}

function stringSequenceEnd(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x07 || code === 0x9c) return index + 1;
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }
  }
  return value.length;
}

function hardSlice(value: string, width: number): string {
  let result = "";
  let printed = 0;
  for (const character of value) {
    const cost = WIDE_PATTERN.test(character) ? 2 : 1;
    if (printed + cost > width) break;
    result += character;
    printed += cost;
  }
  return result || value.slice(0, width);
}

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatCount(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${trimZeros((tokens / 1_000).toFixed(1))}k`;
  return `${trimZeros((tokens / 1_000_000).toFixed(2))}M`;
}

/** 416.0k reads as noise next to 81.5k; a round number should look round. */
function trimZeros(value: string): string {
  return value.replace(/\.0+$/, "");
}
