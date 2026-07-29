import {
  glyph,
  paint,
  sanitizeTerminalText,
  tone,
  visibleWidth,
  type ColorName,
} from "./theme.ts";

/**
 * A small Markdown renderer for assistant prose.
 *
 * Models answer in Markdown whether or not we ask them to, so the transcript
 * either interprets it or prints the punctuation raw. This covers the subset
 * that actually shows up in coding answers — emphasis, code, lists, headings,
 * quotes, rules, fenced blocks, and simple tables — and deliberately stops
 * short of a full CommonMark implementation.
 */

type Style = "bold" | "italic" | "code" | "link" | "url" | "strike";

interface Segment {
  text: string;
  styles: Style[];
}

interface Token {
  text: string;
  styles: Style[];
  space: boolean;
}

const STYLE_COLORS: Record<Style, ColorName[]> = {
  bold: ["bold"],
  italic: ["italic"],
  code: ["cyan"],
  link: ["cyan"],
  url: ["dim"],
  strike: ["dim"],
};

/** Bullets get quieter as nesting deepens, so structure reads at a glance. */
const BULLETS = ["•", "◦", "·"];
const MAX_LIST_DEPTH = 3;

export function renderMarkdown(source: string, width: number): string[] {
  const usable = Math.max(1, width);
  const lines = sanitizeTerminalText(source).replace(/\r/g, "").split("\n");
  const out: string[] = [];

  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? "";

    if (!line.trim()) {
      pushBlank(out);
      index += 1;
      continue;
    }

    const fence = /^\s*(`{3,}|~{3,})\s*([^\s`~]*)/.exec(line);
    if (fence) {
      index = renderFence(lines, index, fence[1] ?? "```", usable, out);
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      pushBlank(out);
      out.push(
        ...wrapSegments(
          inlineSegments(heading[2] ?? "", ["bold"]),
          usable,
          "",
          "",
        ),
      );
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
      pushBlank(out);
      out.push(tone.detail("─".repeat(usable)));
      index += 1;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      index = renderQuote(lines, index, usable, out);
      continue;
    }

    if (listMatch(line)) {
      index = renderList(lines, index, usable, out);
      continue;
    }

    const table = tableAt(lines, index);
    if (table) {
      index = renderTable(lines, index, table, usable, out);
      continue;
    }

    index = renderParagraph(lines, index, usable, out);
  }

  while (out.length && out.at(-1) === "") out.pop();
  return out;
}

// ------------------------------------------------------------------- blocks

function renderFence(
  lines: string[],
  start: number,
  marker: string,
  width: number,
  out: string[],
): number {
  const closer = new RegExp(`^\\s*${marker[0] === "`" ? "`" : "~"}{3,}\\s*$`);
  let index = start + 1;
  const body: string[] = [];
  while (index < lines.length && !closer.test(lines[index] ?? "")) {
    body.push(lines[index] ?? "");
    index += 1;
  }
  // An unterminated fence still renders as code; models truncate mid-block.
  if (index < lines.length) index += 1;

  while (body.length && !body[0]?.trim()) body.shift();
  while (body.length && !body.at(-1)?.trim()) body.pop();

  pushBlank(out);
  const indent = "  ";
  const codeWidth = Math.max(1, width - indent.length);
  for (const row of body) {
    for (const piece of hardWrap(row.replace(/\t/g, "  "), codeWidth)) {
      out.push(`${indent}${tone.detail(piece)}`);
    }
  }
  pushBlank(out);
  return index;
}

function renderQuote(
  lines: string[],
  start: number,
  width: number,
  out: string[],
): number {
  let index = start;
  const body: string[] = [];
  while (index < lines.length && /^\s{0,3}>/.test(lines[index] ?? "")) {
    body.push((lines[index] ?? "").replace(/^\s{0,3}>\s?/, ""));
    index += 1;
  }
  pushBlank(out);
  const gutter = `${tone.detail(glyph.continuation)} `;
  for (const row of renderMarkdown(body.join("\n"), Math.max(1, width - 2))) {
    out.push(row ? `${gutter}${row}` : tone.detail(glyph.continuation));
  }
  pushBlank(out);
  return index;
}

interface ListItem {
  depth: number;
  marker: string;
  text: string;
}

function listMatch(line: string): ListItem | null {
  const match = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/.exec(line);
  if (!match) return null;
  const depth = Math.min(
    MAX_LIST_DEPTH - 1,
    Math.floor((match[1] ?? "").replace(/\t/g, "  ").length / 2),
  );
  return {
    depth,
    marker: match[2]
      ? (BULLETS[depth] ?? BULLETS.at(-1) ?? "•")
      : `${match[3]}.`,
    text: match[4] ?? "",
  };
}

function renderList(
  lines: string[],
  start: number,
  width: number,
  out: string[],
): number {
  let index = start;
  pushBlank(out);
  while (index < lines.length) {
    const item = listMatch(lines[index] ?? "");
    if (!item) break;
    index += 1;

    // Lazy continuation: wrapped item text on following indented lines.
    const parts = [item.text];
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (!next.trim() || listMatch(next)) break;
      if (!/^\s{2,}\S/.test(next)) break;
      if (/^\s*(?:`{3,}|~{3,}|#{1,6}\s|>)/.test(next)) break;
      parts.push(next.trim());
      index += 1;
    }

    const gutter = " ".repeat(item.depth * 2);
    const marker = `${gutter}${tone.detail(item.marker)} `;
    const hanging = " ".repeat(gutter.length + item.marker.length + 1);
    out.push(
      ...wrapSegments(
        inlineSegments(parts.join(" ")),
        Math.max(1, width - hanging.length),
        marker,
        hanging,
      ),
    );

    // A blank line between items ends the list unless another item follows.
    if (index < lines.length && !(lines[index] ?? "").trim()) {
      if (!listMatch(lines[index + 1] ?? "")) break;
      index += 1;
    }
  }
  pushBlank(out);
  return index;
}

function renderParagraph(
  lines: string[],
  start: number,
  width: number,
  out: string[],
): number {
  let index = start;
  const parts: string[] = [];
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) break;
    if (listMatch(line)) break;
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) break;
    if (/^\s{0,3}(?:#{1,6}\s|>)/.test(line)) break;
    if (tableAt(lines, index)) break;
    parts.push(line.trim());
    index += 1;
  }
  out.push(...wrapSegments(inlineSegments(parts.join(" ")), width, "", ""));
  return index;
}

// -------------------------------------------------------------------- tables

type Alignment = "left" | "right" | "center";

/** Below this a column splits words down the middle, so we stop gridding. */
const MIN_COLUMN = 8;
/** A stacked label may crowd its value this far and no further. */
const MIN_FIELD = 4;
const COLUMN_GAP = 2;

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function tableAt(lines: string[], index: number): Alignment[] | null {
  const header = lines[index] ?? "";
  const divider = lines[index + 1] ?? "";
  if (!header.includes("|") || !divider.includes("-")) return null;
  const cells = splitRow(divider);
  if (cells.length < 2) return null;
  if (!cells.every((cell) => /^:?-{1,}:?$/.test(cell))) return null;
  if (splitRow(header).length !== cells.length) return null;
  return cells.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    return right ? "right" : "left";
  });
}

function renderTable(
  lines: string[],
  start: number,
  alignments: Alignment[],
  width: number,
  out: string[],
): number {
  const header = splitRow(lines[start] ?? "");
  let index = start + 2;
  const body: string[][] = [];
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim() || !line.includes("|")) break;
    const cells = splitRow(line);
    body.push(
      alignments.map((_, column) => cells[column] ?? ""),
    );
    index += 1;
  }

  const widths = columnWidths([header, ...body], alignments.length, width);
  if (!widths) {
    renderStacked(header, body, width, out);
    return index;
  }

  pushBlank(out);
  out.push(
    ...row(header, widths, alignments, (cell) => inlineSegments(cell, ["bold"])),
  );
  out.push(
    tone.detail(
      widths.map((size) => "─".repeat(size)).join(" ".repeat(COLUMN_GAP)),
    ),
  );
  for (const cells of body) {
    out.push(...row(cells, widths, alignments, (cell) => inlineSegments(cell)));
  }
  pushBlank(out);
  return index;
}

/**
 * Shrink the widest columns first until the table fits; cells reflow into
 * whatever they are given. Returns null once that would push a column under
 * MIN_COLUMN, since a grid of one-letter shards reads worse than no grid.
 */
function columnWidths(
  rows: string[][],
  columns: number,
  width: number,
): number[] | null {
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(
      ...rows.map((row) => visibleWidth(plainInline(row[column] ?? ""))),
      1,
    ),
  );

  // A column already narrower than the floor is left alone rather than padded.
  const floors = widths.map((natural) => Math.min(natural, MIN_COLUMN));
  const budget = width - COLUMN_GAP * (columns - 1);
  if (budget < columns) return null;

  while (sum(widths) > budget) {
    let target = -1;
    for (let column = 0; column < columns; column += 1) {
      if ((widths[column] ?? 0) <= (floors[column] ?? 1)) continue;
      if (target < 0 || (widths[column] ?? 0) > (widths[target] ?? 0)) {
        target = column;
      }
    }
    if (target < 0) return null;
    widths[target] = (widths[target] ?? 1) - 1;
  }
  return widths;
}

/** One row of cells, top-aligned across however many lines the tallest needs. */
function row(
  cells: string[],
  widths: number[],
  alignments: Alignment[],
  segmentsFor: (cell: string) => Segment[],
): string[] {
  const wrapped = widths.map((size, column) =>
    wrapSegments(segmentsFor(cells[column] ?? ""), size, "", ""),
  );
  const height = Math.max(...wrapped.map((lines) => lines.length), 1);

  const rendered: string[] = [];
  for (let line = 0; line < height; line += 1) {
    rendered.push(
      widths
        .map((size, column) =>
          padCell(
            wrapped[column]?.[line] ?? "",
            size,
            alignments[column] ?? "left",
          ),
        )
        .join(" ".repeat(COLUMN_GAP))
        .replace(/\s+$/, ""),
    );
  }
  return rendered;
}

function padCell(line: string, width: number, alignment: Alignment): string {
  const missing = Math.max(0, width - visibleWidth(line));
  if (alignment === "right") return `${" ".repeat(missing)}${line}`;
  if (alignment === "center") {
    const left = Math.floor(missing / 2);
    return `${" ".repeat(left)}${line}${" ".repeat(missing - left)}`;
  }
  return `${line}${" ".repeat(missing)}`;
}

/**
 * Too narrow for columns: each row becomes its own labelled block, with the
 * header cells demoted to field labels. Losing the grid beats losing the words.
 */
function renderStacked(
  header: string[],
  body: string[][],
  width: number,
  out: string[],
): void {
  const labels = header.map((cell) => plainInline(cell).trim());
  const push = (lines: string[]): void => {
    for (const line of lines) out.push(line.replace(/\s+$/, ""));
  };

  pushBlank(out);
  if (body.length === 0) {
    push(wrapSegments(inlineSegments(labels.join(" · "), ["bold"]), width, "", ""));
    pushBlank(out);
    return;
  }

  body.forEach((cells, index) => {
    if (index > 0) out.push(tone.detail("─".repeat(Math.min(width, 8))));
    cells.forEach((cell, column) => {
      const label = labels[column] ?? "";
      const marker = label ? `${label}: ` : "";
      const room = width - visibleWidth(marker);
      // A label that leaves no room for its value takes a line of its own.
      if (marker && room < MIN_FIELD) {
        push(wrapSegments(inlineSegments(label, ["bold"]), width, "", ""));
        push(
          wrapSegments(
            inlineSegments(cell),
            Math.max(1, width - COLUMN_GAP),
            " ".repeat(COLUMN_GAP),
            " ".repeat(COLUMN_GAP),
          ),
        );
        return;
      }
      push(
        wrapSegments(
          inlineSegments(cell),
          Math.max(1, room),
          tone.detail(marker),
          " ".repeat(visibleWidth(marker)),
        ),
      );
    });
  });
  pushBlank(out);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

// -------------------------------------------------------------------- inline

function inlineSegments(source: string, inherited: Style[] = []): Segment[] {
  const segments: Segment[] = [];
  let plain = "";
  let index = 0;

  const flush = (): void => {
    if (!plain) return;
    segments.push({ text: plain, styles: inherited });
    plain = "";
  };

  while (index < source.length) {
    const rest = source.slice(index);

    if (rest.startsWith("\\") && rest.length > 1) {
      plain += rest[1];
      index += 2;
      continue;
    }

    const code = /^(`+)([^`]|[\s\S]*?[^`])\1(?!`)/.exec(rest);
    if (code) {
      flush();
      segments.push({
        text: (code[2] ?? "").trim(),
        styles: withStyle(inherited, "code"),
      });
      index += code[0].length;
      continue;
    }

    const link = /^!?\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.exec(rest);
    if (link) {
      flush();
      const label = (link[1] ?? "").trim();
      segments.push(
        ...inlineSegments(label || (link[2] ?? ""), withStyle(inherited, "link")),
      );
      if (label && link[2] && label !== link[2]) {
        segments.push({
          text: ` (${link[2]})`,
          styles: withStyle(inherited, "url"),
        });
      }
      index += link[0].length;
      continue;
    }

    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong) {
      flush();
      segments.push(
        ...inlineSegments(strong[2] ?? "", withStyle(inherited, "bold")),
      );
      index += strong[0].length;
      continue;
    }

    const strike = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest);
    if (strike) {
      flush();
      segments.push(
        ...inlineSegments(strike[1] ?? "", withStyle(inherited, "strike")),
      );
      index += strike[0].length;
      continue;
    }

    // `_` only opens emphasis at a word boundary so snake_case survives.
    const emphasis =
      rest[0] === "*"
        ? /^\*(?=\S)([\s\S]*?\S)\*(?!\*)/.exec(rest)
        : index === 0 || /[\s(]/.test(source[index - 1] ?? " ")
          ? /^_(?=\S)([\s\S]*?\S)_(?![\w_])/.exec(rest)
          : null;
    if (emphasis) {
      flush();
      segments.push(
        ...inlineSegments(emphasis[1] ?? "", withStyle(inherited, "italic")),
      );
      index += emphasis[0].length;
      continue;
    }

    const bare = /^<((?:https?|file):\/\/[^>\s]+)>/.exec(rest);
    if (bare) {
      flush();
      segments.push({
        text: bare[1] ?? "",
        styles: withStyle(inherited, "link"),
      });
      index += bare[0].length;
      continue;
    }

    plain += source[index];
    index += 1;
  }

  flush();
  return segments;
}

function withStyle(styles: Style[], next: Style): Style[] {
  return styles.includes(next) ? styles : [...styles, next];
}

function styleKey(styles: Style[]): string {
  return styles.join("+");
}

function plainInline(source: string): string {
  return inlineSegments(source)
    .map((segment) => segment.text)
    .join("");
}

function paintSegment(segment: Segment): string {
  if (segment.styles.length === 0) return segment.text;
  const names = [
    ...new Set(segment.styles.flatMap((style) => STYLE_COLORS[style])),
  ];
  return paint(segment.text, ...names);
}

/**
 * Word-wrap styled segments. Wrapping has to happen on the text, not on the
 * painted string, or escape sequences would be counted as visible columns.
 */
function wrapSegments(
  segments: Segment[],
  width: number,
  firstPrefix: string,
  restPrefix: string,
): string[] {
  const usable = Math.max(1, width);
  const tokens: Token[] = [];
  for (const segment of segments) {
    for (const piece of segment.text.split(/(\s+)/)) {
      if (!piece) continue;
      tokens.push({
        text: /^\s+$/.test(piece) ? " " : piece,
        styles: segment.styles,
        space: /^\s+$/.test(piece),
      });
    }
  }

  const lines: string[] = [];
  let current: Token[] = [];
  let columns = 0;

  const flushLine = (): void => {
    while (current.at(-1)?.space) current.pop();
    // Adjacent words share one escape pair instead of one pair per word.
    const merged: Segment[] = [];
    for (const token of current) {
      const last = merged.at(-1);
      if (last && styleKey(last.styles) === styleKey(token.styles)) {
        last.text += token.text;
      } else {
        merged.push({ text: token.text, styles: token.styles });
      }
    }
    lines.push(merged.map(paintSegment).join(""));
    current = [];
    columns = 0;
  };

  for (const token of tokens) {
    if (token.space) {
      if (columns > 0) {
        current.push(token);
        columns += 1;
      }
      continue;
    }

    let text = token.text;
    while (visibleWidth(text) > usable) {
      // A single token wider than the line (a long path or URL) is split.
      const room = columns > 0 ? usable - columns : usable;
      if (room <= 1) {
        flushLine();
        continue;
      }
      const [head, tail] = splitAt(text, room);
      current.push({ ...token, text: head });
      flushLine();
      text = tail;
    }

    const tokenWidth = visibleWidth(text);
    if (columns > 0 && columns + tokenWidth > usable) flushLine();
    if (text) {
      current.push({ ...token, text });
      columns += tokenWidth;
    }
  }
  if (current.length) flushLine();
  if (lines.length === 0) lines.push("");

  return lines.map(
    (line, index) => `${index === 0 ? firstPrefix : restPrefix}${line}`,
  );
}

function splitAt(value: string, width: number): [string, string] {
  let head = "";
  let printed = 0;
  for (const character of value) {
    const cost = visibleWidth(character);
    if (printed + cost > width) break;
    head += character;
    printed += cost;
  }
  if (!head) head = value.slice(0, Math.max(1, width));
  return [head, value.slice(head.length)];
}

function hardWrap(value: string, width: number): string[] {
  if (!value) return [""];
  const pieces: string[] = [];
  let rest = value;
  while (visibleWidth(rest) > width) {
    const [head, tail] = splitAt(rest, width);
    pieces.push(head);
    rest = tail;
  }
  pieces.push(rest);
  return pieces;
}

function pushBlank(out: string[]): void {
  if (out.length && out.at(-1) !== "") out.push("");
}
