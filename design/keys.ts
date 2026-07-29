/**
 * keys — turns a raw stdin byte stream into key events.
 *
 * Handles partial sequences across chunk boundaries, xterm modifier encoding,
 * and bracketed paste (so a pasted multi-line snippet never looks like the
 * user pressing Enter forty times).
 */

export interface Key {
  name: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  seq: string;
}

export interface Paste {
  paste: true;
  text: string;
}

export type Input = Key | Paste;

export const PASTE_ON = "\x1b[?2004h";
export const PASTE_OFF = "\x1b[?2004l";

const CSI = /^\x1b\[([0-9;]*)([~A-Za-z])/;
const SS3 = /^\x1bO([A-Za-z])/;

const ARROWS: Record<string, string> = { A: "up", B: "down", C: "right", D: "left" };
const TILDE: Record<string, string> = {
  "1": "home",
  "2": "insert",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
};

function key(name: string, seq: string, mod = 0): Key {
  return {
    name,
    seq,
    shift: (mod & 1) !== 0,
    alt: (mod & 2) !== 0,
    ctrl: (mod & 4) !== 0,
  };
}

export class KeyDecoder {
  private buf = "";
  private pasting = false;

  /** Feed a chunk; returns every complete event it yields. */
  feed(chunk: Buffer | string): Input[] {
    this.buf += chunk.toString("utf8");
    const out: Input[] = [];

    while (this.buf.length) {
      if (this.pasting) {
        const end = this.buf.indexOf("\x1b[201~");
        if (end === -1) return out; // wait for the rest
        out.push({ paste: true, text: this.buf.slice(0, end) });
        this.buf = this.buf.slice(end + 6);
        this.pasting = false;
        continue;
      }

      if (this.buf.startsWith("\x1b[200~")) {
        this.buf = this.buf.slice(6);
        this.pasting = true;
        continue;
      }

      const ev = this.next();
      if (!ev) return out; // incomplete sequence, wait
      out.push(ev);
    }

    return out;
  }

  /**
   * Call on a ~20ms idle timer. A lone ESC is ambiguous until you know no
   * bytes follow, so it is held back and released here.
   */
  flush(): Input[] {
    if (this.buf !== "\x1b") return [];
    this.buf = "";
    return [key("escape", "\x1b")];
  }

  private next(): Input | null {
    const b = this.buf;

    if (b[0] === "\x1b") {
      if (b.length === 1) return null; // might be the start of a sequence

      const csi = CSI.exec(b);
      if (csi) {
        this.buf = b.slice(csi[0].length);
        const params = csi[1].split(";");
        const mod = params.length > 1 ? Number(params[1]) - 1 : 0;
        const final = csi[2];

        if (ARROWS[final]) return key(ARROWS[final], csi[0], mod);
        if (final === "H") return key("home", csi[0], mod);
        if (final === "F") return key("end", csi[0], mod);
        if (final === "~" && TILDE[params[0]]) return key(TILDE[params[0]], csi[0], mod);
        return key("unknown", csi[0], mod);
      }

      const ss3 = SS3.exec(b);
      if (ss3) {
        this.buf = b.slice(ss3[0].length);
        const n = ARROWS[ss3[1]] ?? (ss3[1] === "H" ? "home" : ss3[1] === "F" ? "end" : "unknown");
        return key(n, ss3[0]);
      }

      if (b.length >= 2 && b[1] !== "[" && b[1] !== "O") {
        const ch = String.fromCodePoint(b.codePointAt(1)!);
        this.buf = b.slice(1 + ch.length);
        if (ch === "\r" || ch === "\n") return key("enter", "\x1b" + ch, 2);
        if (ch === "\x7f") return key("backspace", "\x1b" + ch, 2);
        return { ...key(ch, "\x1b" + ch), alt: true };
      }

      return null;
    }

    const cp = b.codePointAt(0)!;
    const ch = String.fromCodePoint(cp);
    this.buf = b.slice(ch.length);

    if (ch === "\r") return key("enter", ch);
    if (ch === "\n") return { ...key("enter", ch), ctrl: true };
    if (ch === "\t") return key("tab", ch);
    if (ch === "\x7f" || ch === "\b") return key("backspace", ch);

    if (cp >= 1 && cp <= 26) {
      return { ...key(String.fromCharCode(cp + 96), ch), ctrl: true };
    }
    if (cp < 32) return key("unknown", ch);

    return key(ch, ch);
  }
}

/** Put the terminal in the state an editor needs, and give back the undo. */
export function rawMode(stream: NodeJS.ReadStream = process.stdin): () => void {
  const wasRaw = stream.isRaw;
  if (stream.isTTY) stream.setRawMode(true);
  stream.resume();
  process.stdout.write(PASTE_ON);

  return () => {
    process.stdout.write(PASTE_OFF);
    if (stream.isTTY) stream.setRawMode(wasRaw ?? false);
    stream.pause();
  };
}
