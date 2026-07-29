/**
 * Editor — multi-line input for an agent prompt.
 *
 * Deliberately not a text editor. It does what people actually do at an agent
 * prompt: type a sentence, paste a stack trace, recall the last thing they
 * asked, and fix a typo three words back. Everything else is out of scope.
 */

import { CURSOR, wrapLine, displayWidth } from "./live-region.js";
import { C, G, GUTTER_W } from "./gutter.js";
import type { Input, Key } from "./keys.js";

export interface EditorHandlers {
  /** Enter on a complete input. */
  onSubmit?(text: string): void;
  /** Ctrl+C. The app decides: abort the turn, or exit on a second press. */
  onCancel?(): void;
  /** Ctrl+D on an empty prompt. */
  onExit?(): void;
  /** Any content change — hook completions off this. */
  onChange?(text: string): void;
}

const WORD = /[\p{L}\p{N}_]/u;

export class Editor {
  private lines: string[] = [""];
  private row = 0;
  private col = 0;

  private history: string[] = [];
  private histIndex = -1;
  private draft = "";

  constructor(
    private handlers: EditorHandlers = {},
    private placeholder = "ask anything  ·  / commands  ·  @ files",
  ) {}

  /* --------------------------------------------------------------- state */

  get text(): string {
    return this.lines.join("\n");
  }

  set text(v: string) {
    this.lines = v.split("\n");
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row].length;
    this.handlers.onChange?.(this.text);
  }

  get isEmpty(): boolean {
    return this.text.length === 0;
  }

  clear(): void {
    this.lines = [""];
    this.row = 0;
    this.col = 0;
    this.handlers.onChange?.("");
  }

  /* ---------------------------------------------------------------- input */

  handle(ev: Input): void {
    if ("paste" in ev) {
      this.insert(ev.text.replace(/\r\n?/g, "\n"));
      return;
    }
    const k = ev as Key;

    if (k.ctrl) {
      switch (k.name) {
        case "c":
          if (!this.isEmpty) this.clear();
          else this.handlers.onCancel?.();
          return;
        case "d":
          if (this.isEmpty) this.handlers.onExit?.();
          return;
        case "a":
          this.col = 0;
          return;
        case "e":
          this.col = this.cur.length;
          return;
        case "u":
          this.cur = this.cur.slice(this.col);
          this.col = 0;
          this.changed();
          return;
        case "k":
          this.cur = this.cur.slice(0, this.col);
          this.changed();
          return;
        case "w":
          this.deleteWordLeft();
          return;
        case "enter":
          this.insert("\n");
          return;
        case "left":
          this.col = this.wordLeft();
          return;
        case "right":
          this.col = this.wordRight();
          return;
      }
      return;
    }

    if (k.alt) {
      if (k.name === "enter") return this.insert("\n");
      if (k.name === "left") return void (this.col = this.wordLeft());
      if (k.name === "right") return void (this.col = this.wordRight());
      if (k.name === "backspace") return this.deleteWordLeft();
      return;
    }

    switch (k.name) {
      case "enter":
        // A trailing backslash means "keep going" rather than "send".
        if (this.cur.endsWith("\\")) {
          this.cur = this.cur.slice(0, -1);
          this.col = Math.min(this.col, this.cur.length);
          this.insert("\n");
          return;
        }
        this.submit();
        return;

      case "backspace":
        if (this.col > 0) {
          const n = this.prevBoundary();
          this.cur = this.cur.slice(0, n) + this.cur.slice(this.col);
          this.col = n;
          this.changed();
        } else if (this.row > 0) {
          const prev = this.lines[this.row - 1];
          this.lines.splice(this.row, 1);
          this.row--;
          this.col = prev.length;
          this.lines[this.row] = prev + this.cur0(this.row + 1);
          this.changed();
        }
        return;

      case "delete":
        if (this.col < this.cur.length) {
          const n = this.nextBoundary();
          this.cur = this.cur.slice(0, this.col) + this.cur.slice(n);
          this.changed();
        }
        return;

      case "left":
        if (this.col > 0) this.col = this.prevBoundary();
        else if (this.row > 0) this.col = this.lines[--this.row].length;
        return;

      case "right":
        if (this.col < this.cur.length) this.col = this.nextBoundary();
        else if (this.row < this.lines.length - 1) (this.row++, (this.col = 0));
        return;

      case "home":
        this.col = 0;
        return;
      case "end":
        this.col = this.cur.length;
        return;

      case "up":
        if (this.row > 0) {
          this.row--;
          this.col = Math.min(this.col, this.cur.length);
        } else {
          this.recall(-1);
        }
        return;

      case "down":
        if (this.row < this.lines.length - 1) {
          this.row++;
          this.col = Math.min(this.col, this.cur.length);
        } else {
          this.recall(1);
        }
        return;

      case "escape":
      case "tab":
      case "unknown":
        return;

      default:
        if (k.name.length >= 1 && !k.ctrl) this.insert(k.name);
    }
  }

  /* --------------------------------------------------------------- render */

  /** Physical rows, with the cursor sentinel embedded. */
  render(width: number): string[] {
    const inner = Math.max(1, width - GUTTER_W);

    if (this.isEmpty) {
      return [C.accent(G.user) + " " + CURSOR + C.dim(this.placeholder)];
    }

    const marked = this.lines.map((line, i) =>
      i === this.row ? line.slice(0, this.col) + CURSOR + line.slice(this.col) : line,
    );

    const rows: string[] = [];
    marked.forEach((line, i) => {
      const wrapped = wrapLine(line, inner);
      wrapped.forEach((w, j) => {
        const glyph = i === 0 && j === 0 ? C.accent(G.user) + " " : "  ";
        rows.push(glyph + w);
      });
    });
    return rows;
  }

  /* -------------------------------------------------------------- history */

  pushHistory(text: string): void {
    if (text && this.history[this.history.length - 1] !== text) this.history.push(text);
    this.histIndex = -1;
  }

  private recall(dir: -1 | 1): void {
    if (!this.history.length) return;

    if (this.histIndex === -1) {
      if (dir === 1) return;
      this.draft = this.text;
      this.histIndex = this.history.length - 1;
    } else {
      const next = this.histIndex + dir;
      if (next < 0) return;
      if (next >= this.history.length) {
        this.histIndex = -1;
        this.text = this.draft;
        return;
      }
      this.histIndex = next;
    }
    this.text = this.history[this.histIndex];
  }

  /* --------------------------------------------------------------- internals */

  private get cur(): string {
    return this.lines[this.row];
  }
  private set cur(v: string) {
    this.lines[this.row] = v;
  }
  private cur0(i: number): string {
    return this.lines.splice(i, 1)[0] ?? "";
  }

  private changed(): void {
    this.handlers.onChange?.(this.text);
  }

  private submit(): void {
    const text = this.text.trim();
    if (!text) return;
    this.pushHistory(text);
    this.clear();
    this.handlers.onSubmit?.(text);
  }

  private insert(s: string): void {
    const parts = s.split("\n");
    const before = this.cur.slice(0, this.col);
    const after = this.cur.slice(this.col);

    if (parts.length === 1) {
      this.cur = before + s + after;
      this.col += s.length;
    } else {
      const inserted = [before + parts[0], ...parts.slice(1)];
      inserted[inserted.length - 1] += after;
      this.lines.splice(this.row, 1, ...inserted);
      this.row += parts.length - 1;
      this.col = parts[parts.length - 1].length;
    }
    this.changed();
  }

  /** Step by code point, not code unit, so surrogate pairs stay intact. */
  private prevBoundary(): number {
    const s = this.cur;
    let n = this.col - 1;
    if (n > 0 && s.codePointAt(n - 1)! > 0xffff) n--;
    return Math.max(0, n);
  }

  private nextBoundary(): number {
    const s = this.cur;
    const cp = s.codePointAt(this.col)!;
    return Math.min(s.length, this.col + (cp > 0xffff ? 2 : 1));
  }

  private wordLeft(): number {
    const s = this.cur;
    let i = this.col;
    while (i > 0 && !WORD.test(s[i - 1])) i--;
    while (i > 0 && WORD.test(s[i - 1])) i--;
    return i;
  }

  private wordRight(): number {
    const s = this.cur;
    let i = this.col;
    while (i < s.length && !WORD.test(s[i])) i++;
    while (i < s.length && WORD.test(s[i])) i++;
    return i;
  }

  private deleteWordLeft(): void {
    const n = this.wordLeft();
    if (n === this.col) return;
    this.cur = this.cur.slice(0, n) + this.cur.slice(this.col);
    this.col = n;
    this.changed();
  }
}

/** Width of a rendered row, for callers doing their own layout maths. */
export const rowWidth = displayWidth;
