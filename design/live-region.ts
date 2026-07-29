/**
 * LiveRegion — the only rendering primitive an agent TUI needs.
 *
 * Model: the terminal is split into permanent scrollback (printed once, never
 * touched again) and a live region at the bottom (redrawn every frame).
 *
 * Invariant: between renders the cursor always sits at column 0 of the live
 * region's FIRST row. Every operation restores that. This is what makes
 * clearing, reprinting and interleaving permanent output tractable.
 */

const ESC = "\x1b";
const SYNC_ON = `${ESC}[?2026h`;
const SYNC_OFF = `${ESC}[?2026l`;
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;
const CLEAR_DOWN = `${ESC}[0J`;
const RESET = `${ESC}[0m`;

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/;
const ANSI_G = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/**
 * Embed this in a live line to place the terminal's real cursor there.
 * It is a zero-width control pair, so wrapping and width maths ignore it and
 * it survives being wrapped to a continuation row. Stripped before printing.
 */
export const CURSOR = "\x00\x01";

/* ------------------------------------------------------------------ width */

function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0x200d
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Visible columns a string occupies, ignoring ANSI sequences. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI_G, "")) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/**
 * Hard-wrap one logical line into physical rows of at most `width` columns.
 *
 * We wrap ourselves rather than letting the terminal do it, because terminals
 * disagree about what happens at exactly column N (deferred wrap). Doing it
 * here means printed rows == physical rows, always.
 *
 * Active SGR state is closed at each break and reopened on the next row so
 * colours survive wrapping.
 */
export function wrapLine(line: string, width: number): string[] {
  if (width <= 0) return [line];
  const rows: string[] = [];
  let cur = "";
  let curW = 0;
  let style = "";
  let i = 0;

  while (i < line.length) {
    if (line[i] === ESC) {
      const m = ANSI.exec(line.slice(i));
      if (m && m.index === 0) {
        cur += m[0];
        if (m[0].endsWith("m")) {
          style = m[0] === `${ESC}[0m` || m[0] === `${ESC}[m` ? "" : style + m[0];
        }
        i += m[0].length;
        continue;
      }
    }
    const cp = line.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const w = charWidth(cp);
    if (curW + w > width) {
      rows.push(style ? cur + RESET : cur);
      cur = style;
      curW = 0;
    }
    cur += ch;
    curW += w;
    i += ch.length;
  }

  rows.push(style ? cur + RESET : cur);
  return rows;
}

/* ------------------------------------------------------------- live region */

export interface LiveRegionOptions {
  /** Minimum ms between frames. 33 ≈ 30fps. */
  minFrameMs?: number;
  stream?: NodeJS.WriteStream;
}

export class LiveRegion {
  private out: NodeJS.WriteStream;
  private minFrameMs: number;

  /** Logical lines the caller wants displayed. */
  private lines: string[] = [];
  /** Physical rows currently believed to be on screen. */
  private onScreen: string[] = [];

  /** Rows below home where the visible cursor currently sits. */
  private cursorRow = 0;
  private lastCursorRow = -1;
  private lastCursorCol = 0;

  private timer: NodeJS.Timeout | null = null;
  private lastFrame = 0;
  private started = false;
  private onResize = () => this.repaint();

  constructor(opts: LiveRegionOptions = {}) {
    this.out = opts.stream ?? process.stdout;
    this.minFrameMs = opts.minFrameMs ?? 33;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.out.write("\r" + CLEAR_DOWN);
    this.out.on("resize", this.onResize);
    process.once("exit", () => this.stop());
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.out.off("resize", this.onResize);
    this.out.write(CLEAR_DOWN + SHOW);
    this.onScreen = [];
    this.lines = [];
  }

  /** Replace the live content. Cheap — coalesced into the next frame. */
  set(lines: string[]): void {
    this.lines = lines;
    this.schedule();
  }

  /**
   * Move `lines` into permanent scrollback, above the live region.
   * This is `commit` — call it when a block stops changing.
   */
  commit(lines: string[]): void {
    this.flushTimer();
    const wrapped = lines.flatMap((l) => wrapLine(l, this.width));
    this.out.write(HIDE + this.toHome() + CLEAR_DOWN + wrapped.join("\n") + "\n");
    this.cursorRow = 0;
    this.onScreen = [];
    this.render(true);
  }

  /** Force a full redraw — after SIGWINCH, or a foreign write to stdout. */
  repaint(): void {
    this.onScreen = [];
    this.render(true);
  }

  private get width(): number {
    return this.out.columns || 80;
  }

  private get height(): number {
    return this.out.rows || 24;
  }

  private schedule(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.minFrameMs - (Date.now() - this.lastFrame));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.render(false);
    }, wait);
  }

  private flushTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Escape sequence to get from the visible cursor back to home. */
  private toHome(): string {
    return (this.cursorRow > 0 ? `${ESC}[${this.cursorRow}A` : "") + "\r";
  }

  private render(force: boolean): void {
    if (!this.started) return;
    this.lastFrame = Date.now();

    let next = this.lines.flatMap((l) => wrapLine(l, this.width));

    // Locate and strip the cursor sentinel.
    let curRow = -1;
    let curCol = 0;
    for (let i = 0; i < next.length; i++) {
      const at = next[i].indexOf(CURSOR);
      if (at === -1) continue;
      curRow = i;
      curCol = displayWidth(next[i].slice(0, at));
      next[i] = next[i].replace(CURSOR, "");
      break;
    }

    // Never let the live region fill the screen — it must not scroll away
    // the scrollback we just committed.
    const cap = Math.max(1, this.height - 1);
    if (next.length > cap) next = next.slice(next.length - cap);

    // First row that differs. Streaming appends at the bottom, so this is
    // usually near the end and we reprint almost nothing.
    let k = 0;
    if (!force) {
      const common = Math.min(next.length, this.onScreen.length);
      while (k < common && next[k] === this.onScreen[k]) k++;
      const moved = curRow !== this.lastCursorRow || curCol !== this.lastCursorCol;
      if (k === next.length && next.length === this.onScreen.length && !moved) return;
    }

    const tail = next.slice(k);
    let seq = SYNC_ON + HIDE + this.toHome();
    this.cursorRow = 0;
    if (k > 0) seq += `${ESC}[${k}B`;
    seq += CLEAR_DOWN;
    if (tail.length) seq += tail.join("\n");

    // Restore the invariant: back to column 0 of row 0.
    const endRow = tail.length ? k + tail.length - 1 : k;
    if (endRow > 0) seq += `${ESC}[${endRow}A`;
    seq += "\r";

    // Then place the visible cursor, remembering how to get back.
    if (curRow >= 0 && curRow < next.length) {
      if (curRow > 0) seq += `${ESC}[${curRow}B`;
      if (curCol > 0) seq += `${ESC}[${curCol}C`;
      this.cursorRow = curRow;
      seq += SHOW;
    }
    seq += SYNC_OFF;

    this.out.write(seq);
    this.onScreen = next;
    this.lastCursorRow = curRow;
    this.lastCursorCol = curCol;
  }
}
