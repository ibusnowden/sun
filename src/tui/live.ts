import type { RunMode } from "../core/types.ts";
import { renderStatus } from "./chrome.ts";
import {
  renderCompletionMenu,
  type CompletionItem,
  type CompletionTrigger,
} from "./completion.ts";
import { renderSelect, type SelectView } from "./select.ts";
import {
  formatDuration,
  glyph,
  pad,
  sanitizeTerminalText,
  tone,
  truncate,
  visibleWidth,
  wrap,
} from "./theme.ts";

export interface Key {
  name:
    | "char"
    | "enter"
    | "newline"
    | "backspace"
    | "delete"
    | "left"
    | "right"
    | "up"
    | "down"
    | "home"
    | "end"
    | "escape"
    | "tab"
    | "interrupt"
    | "eof"
    | "kill-line"
    | "kill-word"
    | "clear-screen"
    | "paste"
    | "unknown";
  text: string;
}

const SEQUENCES: Record<string, Key["name"]> = {
  "\x1b[A": "up",
  "\x1bOA": "up",
  "\x1b[B": "down",
  "\x1bOB": "down",
  "\x1b[C": "right",
  "\x1bOC": "right",
  "\x1b[D": "left",
  "\x1bOD": "left",
  "\x1b[H": "home",
  "\x1bOH": "home",
  "\x1b[1~": "home",
  "\x1b[F": "end",
  "\x1bOF": "end",
  "\x1b[4~": "end",
  "\x1b[3~": "delete",
};

/** Stateful raw-input decoder with partial-sequence and bracketed-paste support. */
export class KeyDecoder {
  #buffer = "";
  #pasting = false;

  feed(raw: Buffer | string): Key[] {
    this.#buffer += raw.toString();
    const keys: Key[] = [];
    while (this.#buffer) {
      if (this.#pasting) {
        const end = this.#buffer.indexOf("\x1b[201~");
        if (end === -1) return keys;
        keys.push({ name: "paste", text: this.#buffer.slice(0, end) });
        this.#buffer = this.#buffer.slice(end + 6);
        this.#pasting = false;
        continue;
      }
      if (this.#buffer.startsWith("\x1b[200~")) {
        this.#buffer = this.#buffer.slice(6);
        this.#pasting = true;
        continue;
      }
      const next = this.#next();
      if (!next) return keys;
      keys.push(next);
    }
    return keys;
  }

  flush(): Key[] {
    if (this.#buffer === "\x1b") {
      this.#buffer = "";
      return [{ name: "escape", text: "" }];
    }
    return [];
  }

  #next(): Key | null {
    const rest = this.#buffer;
    const sequence = Object.keys(SEQUENCES).find((candidate) =>
      rest.startsWith(candidate),
    );
    if (sequence) {
      this.#buffer = rest.slice(sequence.length);
      return { name: SEQUENCES[sequence] ?? "unknown", text: "" };
    }
    if (
      rest.startsWith("\x1b") &&
      Object.keys(SEQUENCES).some((candidate) => candidate.startsWith(rest))
    ) {
      return null;
    }
    if (rest.startsWith("\x1b")) {
      if (rest.length === 1) return null;
      if (rest[1] === "\r" || rest[1] === "\n") {
        this.#buffer = rest.slice(2);
        return { name: "newline", text: "" };
      }
      const control = /^\x1b(?:\[[0-9;?]*[A-Za-z~]|O[A-Za-z])/.exec(rest);
      if (control) {
        this.#buffer = rest.slice(control[0].length);
        return { name: "unknown", text: "" };
      }
      if (rest.startsWith("\x1b[") || rest.startsWith("\x1bO")) return null;
      const character = String.fromCodePoint(rest.codePointAt(1) ?? 32);
      this.#buffer = rest.slice(1 + character.length);
      return { name: "char", text: character };
    }

    const character = String.fromCodePoint(rest.codePointAt(0) ?? 32);
    this.#buffer = rest.slice(character.length);
    return keyForCharacter(character);
  }
}

/** Convenience decoder for complete strings and unit tests. */
export function decodeKeys(raw: string): Key[] {
  const decoder = new KeyDecoder();
  return [...decoder.feed(raw), ...decoder.flush()];
}

function keyForCharacter(character: string): Key {
  if (character === "\r") return { name: "enter", text: "" };
  if (character === "\n") return { name: "newline", text: "" };
  if (character === "\x7f" || character === "\b") {
    return { name: "backspace", text: "" };
  }
  const controls: Record<string, Key["name"]> = {
    "\x03": "interrupt",
    "\x04": "eof",
    "\x15": "kill-line",
    "\x17": "kill-word",
    "\x0c": "clear-screen",
    "\x01": "home",
    "\x05": "end",
    "\t": "tab",
  };
  const control = controls[character];
  if (control) return { name: control, text: "" };
  if (character >= " ") return { name: "char", text: character };
  return { name: "unknown", text: "" };
}

/** Multiline input with a caret, kill-word support, and command history. */
export class LineEditor {
  #value = "";
  #cursor = 0;
  #history: string[] = [];
  #historyIndex = -1;
  #draft = "";

  get value(): string {
    return this.#value;
  }

  get cursor(): number {
    return this.#cursor;
  }

  set(value: string): void {
    this.replace(value, Number.POSITIVE_INFINITY);
  }

  /** Set the buffer and place the caret, used when a completion is accepted. */
  replace(value: string, cursor: number): void {
    this.#value = sanitizeTerminalText(value);
    this.#cursor = Math.max(0, Math.min(this.#value.length, cursor));
  }

  insert(text: string): void {
    const clean = sanitizeTerminalText(text)
      .replace(/\r\n?/g, "\n")
      .replace(/\t/g, "  ")
      .replace(/[\x00-\x09\x0b-\x1f]/g, "");
    if (!clean) return;
    this.#value =
      this.#value.slice(0, this.#cursor) + clean + this.#value.slice(this.#cursor);
    this.#cursor += clean.length;
  }

  backspace(): void {
    if (this.#cursor === 0) return;
    const boundary = previousBoundary(this.#value, this.#cursor);
    this.#value =
      this.#value.slice(0, boundary) + this.#value.slice(this.#cursor);
    this.#cursor = boundary;
  }

  delete(): void {
    if (this.#cursor >= this.#value.length) return;
    const boundary = nextBoundary(this.#value, this.#cursor);
    this.#value =
      this.#value.slice(0, this.#cursor) + this.#value.slice(boundary);
  }

  killWord(): void {
    if (this.#cursor === 0) return;
    const before = this.#value.slice(0, this.#cursor);
    const trimmed = before.replace(/\s*\S*$/, "");
    this.#value = trimmed + this.#value.slice(this.#cursor);
    this.#cursor = trimmed.length;
  }

  killLine(): void {
    this.#value = "";
    this.#cursor = 0;
  }

  move(delta: number): void {
    this.#cursor = Math.max(0, Math.min(this.#value.length, this.#cursor + delta));
  }

  home(): void {
    this.#cursor = lineStart(this.#value, this.#cursor);
  }

  end(): void {
    this.#cursor = lineEnd(this.#value, this.#cursor);
  }

  previous(): void {
    const start = lineStart(this.#value, this.#cursor);
    if (start > 0) {
      const column = this.#cursor - start;
      const previousEnd = start - 1;
      const previousStart = lineStart(this.#value, previousEnd);
      this.#cursor = Math.min(previousStart + column, previousEnd);
      return;
    }
    if (this.#history.length === 0) return;
    if (this.#historyIndex === -1) {
      this.#draft = this.#value;
      this.#historyIndex = this.#history.length - 1;
    } else if (this.#historyIndex > 0) {
      this.#historyIndex -= 1;
    }
    this.set(this.#history[this.#historyIndex] ?? "");
  }

  next(): void {
    const end = lineEnd(this.#value, this.#cursor);
    if (end < this.#value.length) {
      const column = this.#cursor - lineStart(this.#value, this.#cursor);
      const nextStart = end + 1;
      this.#cursor = Math.min(nextStart + column, lineEnd(this.#value, nextStart));
      return;
    }
    if (this.#historyIndex === -1) return;
    if (this.#historyIndex >= this.#history.length - 1) {
      this.#historyIndex = -1;
      this.set(this.#draft);
      return;
    }
    this.#historyIndex += 1;
    this.set(this.#history[this.#historyIndex] ?? "");
  }

  submit(): string {
    const value = this.#value.trim();
    if (value && this.#history.at(-1) !== value) this.#history.push(value);
    this.#historyIndex = -1;
    this.#draft = "";
    this.killLine();
    return value;
  }
}

function lineStart(value: string, cursor: number): number {
  return value.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
}

function lineEnd(value: string, cursor: number): number {
  const end = value.indexOf("\n", cursor);
  return end === -1 ? value.length : end;
}

function previousBoundary(value: string, cursor: number): number {
  let boundary = cursor - 1;
  if (
    boundary > 0 &&
    (value.charCodeAt(boundary) & 0xfc00) === 0xdc00 &&
    (value.charCodeAt(boundary - 1) & 0xfc00) === 0xd800
  ) {
    boundary -= 1;
  }
  return boundary;
}

function nextBoundary(value: string, cursor: number): number {
  const codePoint = value.codePointAt(cursor);
  return Math.min(value.length, cursor + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1));
}

export interface FooterView {
  busy: boolean;
  activity: string;
  elapsedMs: number;
  totalTokens: number;
  model: string;
  mode: RunMode;
  repository: string;
  input: string;
  cursor: number;
  activeTool: { name: string; target: string } | null;
  notice: string;
  /** The open completion menu, when the caret sits in a `/` or `@` token. */
  completion?: CompletionView | null;
  /** Live model reasoning for the turn in flight; shown only while busy. */
  reasoning?: string;
  /** An open modal choice, which replaces the whole live region. */
  select?: SelectView | null;
  /** Right-hand goal badge on the status line. */
  goal?: string;
  /** Dim example task shown in the empty composer. */
  placeholder?: string;
}

export interface CompletionView {
  trigger: CompletionTrigger;
  items: readonly CompletionItem[];
  selected: number;
}

export interface FooterFrame {
  lines: string[];
  cursorRow: number;
  cursorColumn: number;
}

export function renderFooter(
  view: FooterView,
  requestedWidth: number,
): FooterFrame {
  const width = Math.max(12, requestedWidth);
  const lines: string[] = [];

  // A modal choice owns the whole live region: there is nothing else to type
  // at, so the composer and status line stand down until it is answered.
  if (view.select) {
    return {
      lines: renderSelect(view.select, width),
      cursorRow: 0,
      cursorColumn: 1,
    };
  }

  if (view.busy) {
    lines.push(...reasoningRows(view, width));
    lines.push(workingRow(view, width));
  }

  if (view.notice) {
    lines.push(
      `${tone.warn(glyph.warn)} ${tone.muted(truncate(view.notice, width - 2))}`,
    );
  }

  if (lines.length) lines.push("");
  const box = inputBox(view, width);
  const boxStart = lines.length;
  lines.push(...box.lines);
  lines.push("");

  // The menu hangs below the composer, in the row the status line otherwise
  // occupies: while you are choosing a completion, the model and workspace are
  // not what you need to see.
  if (view.completion) {
    lines.push(
      ...renderCompletionMenu(
        view.completion.items,
        view.completion.selected,
        view.completion.trigger,
        width,
      ),
    );
  } else {
    lines.push(
      ...renderStatus(
        {
          model: view.model,
          repository: view.repository,
          totalTokens: view.totalTokens,
          ...(view.goal ? { goal: view.goal } : {}),
        },
        width,
      ),
    );
  }

  return {
    lines,
    cursorRow: boxStart + box.lines.length - box.cursorFromBottom,
    cursorColumn: box.cursorColumn,
  };
}

/**
 * The model's reasoning as it arrives. Only the tail is shown: this is a
 * window onto a stream, not a transcript of it, and the committed narration
 * bullet is what survives into scrollback.
 */
function reasoningRows(view: FooterView, width: number): string[] {
  const text = (view.reasoning ?? "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const wrapped = wrap(text, Math.max(1, width - 2)).slice(-REASONING_ROWS);
  return [
    ...wrapped.map(
      (line, index) =>
        `${index === 0 ? tone.muted(glyph.bullet) : " "} ${tone.muted(line)}`,
    ),
    "",
  ];
}

/** Rows of streamed reasoning kept on screen. */
const REASONING_ROWS = 3;

/**
 * `• Working (22s • esc to interrupt)` — one row, no spinner. When a tool is
 * in flight its name replaces the verb, so the row always says what is
 * actually taking the time.
 */
function workingRow(view: FooterView, width: number): string {
  const verb = view.activeTool
    ? `${ACTIVE_VERB[view.activeTool.name] ?? "Working"} ${truncateFromLeft(view.activeTool.target, Math.max(8, width - 34))}`
    : "Working";
  const meta = `${formatDuration(view.elapsedMs)} ${glyph.bullet} esc to interrupt`;
  return `${tone.running(glyph.bullet)} ${truncate(
    `${tone.heading(verb)} ${tone.muted(`(${meta})`)}`,
    width - 2,
  )}`;
}

/** What the working row calls each tool while it is still in flight. */
const ACTIVE_VERB: Record<string, string> = {
  read: "Reading",
  edit: "Editing",
  write: "Writing",
  bash: "Running",
};

interface Box {
  lines: string[];
  cursorFromBottom: number;
  cursorColumn: number;
}

function inputBox(view: FooterView, width: number): Box {
  const textWidth = Math.max(8, width - 2);
  const placeholder = view.placeholder ?? "Ask anything";
  const promptColor = tone.info;
  if (!view.input) {
    const placeholderLines =
      visibleWidth(placeholder) <= textWidth
        ? [placeholder]
        : wrap(placeholder, textWidth);
    return {
      lines: placeholderLines.map(
        (line, index) =>
          `${index === 0 ? promptColor(glyph.user) : " "} ${pad(
            tone.muted(line),
            textWidth,
          )}`,
      ),
      cursorFromBottom: placeholderLines.length,
      cursorColumn: 3,
    };
  }

  const rendered: Array<{
    text: string;
    cursorColumn: number | null;
  }> = [];
  let globalStart = 0;
  for (const [logicalIndex, logicalLine] of view.input.split("\n").entries()) {
    const chunks = editorChunks(logicalLine, textWidth);
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const localCursor = view.cursor - globalStart;
      const isLast = chunkIndex === chunks.length - 1;
      const containsCursor =
        localCursor >= chunk.start &&
        (localCursor < chunk.end || (isLast && localCursor === chunk.end));
      rendered.push({
        text: `${logicalIndex === 0 && chunkIndex === 0 ? promptColor(glyph.user) : " "} ${pad(chunk.text, textWidth)}`,
        cursorColumn: containsCursor
          ? 3 +
            visibleWidth(
              logicalLine.slice(chunk.start, Math.max(chunk.start, localCursor)),
            )
          : null,
      });
    }
    globalStart += logicalLine.length + 1;
  }

  const cursorIndex = Math.max(
    0,
    rendered.findIndex((row) => row.cursorColumn !== null),
  );
  const maxRows = 6;
  const start = Math.max(
    0,
    Math.min(cursorIndex - Math.floor(maxRows / 2), rendered.length - maxRows),
  );
  const visibleRows = rendered.slice(start, start + maxRows);
  const visibleCursor = Math.max(0, cursorIndex - start);
  return {
    lines: visibleRows.map((row) => row.text),
    cursorFromBottom: visibleRows.length - visibleCursor,
    cursorColumn: visibleRows[visibleCursor]?.cursorColumn ?? 3,
  };
}

function editorChunks(
  value: string,
  width: number,
): Array<{ text: string; start: number; end: number }> {
  if (!value) return [{ text: "", start: 0, end: 0 }];
  const chunks: Array<{ text: string; start: number; end: number }> = [];
  let text = "";
  let start = 0;
  let end = 0;
  let columns = 0;
  for (const character of value) {
    const characterWidth = visibleWidth(character);
    if (columns > 0 && columns + characterWidth > width) {
      chunks.push({ text, start, end });
      text = "";
      start = end;
      columns = 0;
    }
    text += character;
    end += character.length;
    columns += characterWidth;
  }
  chunks.push({ text, start, end });
  return chunks;
}

function truncateFromLeft(value: string, width: number): string {
  value = sanitizeTerminalText(value);
  if (visibleWidth(value) <= width) return value;
  let tail = value;
  while (tail && visibleWidth(tail) > width - 1) tail = tail.slice(1);
  return `${glyph.ellipsis}${tail}`;
}
