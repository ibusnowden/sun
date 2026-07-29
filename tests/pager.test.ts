import { describe, expect, test } from "bun:test";
import { decodeKeys, KeyDecoder } from "../src/tui/live.ts";
import {
  PAGER_EMPTY,
  pagerBodyHeight,
  pagerMaxOffset,
  pagerPercent,
  pagerScroll,
  pagerTitle,
  refitPager,
  renderPager,
  wrapPatch,
  type PagerState,
} from "../src/tui/pager.ts";
import { setColorEnabled, stripAnsi, visibleWidth } from "../src/tui/theme.ts";

setColorEnabled(true);

const PATCH = [
  "diff --git a/math.js b/math.js",
  "index 0604766..0bd82db 100644",
  "--- a/math.js",
  "+++ b/math.js",
  "@@ -1,3 +1,7 @@",
  " export function add(a, b) {",
  "   return a + b",
  " }",
  "+",
  "+export function subtract(a, b) {",
  "+  return a - b",
  "+}",
].join("\n");

function state(source: string, width = 110, offset = 0): PagerState {
  return {
    title: "diff",
    source,
    rows: wrapPatch(source, width),
    wrappedWidth: width,
    offset,
  };
}

function plain(lines: string[]): string[] {
  return lines.map(stripAnsi);
}

describe("pager layout", () => {
  test("the header is letter-spaced and fills the exact width", () => {
    const header = stripAnsi(pagerTitle("diff", 110));
    expect(header).toStartWith("/ D I F F ");
    expect(header).toHaveLength(110);
    expect(header.endsWith("/ ")).toBe(true);
  });

  test("a narrow terminal truncates the header rather than overflowing", () => {
    expect(stripAnsi(pagerTitle("diff", 6))).toBe("/ D I ");
  });

  test("chrome takes five rows, so the body is height minus five", () => {
    expect(pagerBodyHeight(40)).toBe(35);
    expect(pagerBodyHeight(24)).toBe(19);
  });

  test("a frame is exactly as tall as the terminal", () => {
    for (const rows of [24, 40, 60]) {
      expect(renderPager(state(PATCH), 110, rows)).toHaveLength(rows);
    }
  });

  test("the frame carries header, body, rule, both hints, and a blank", () => {
    const lines = plain(renderPager(state(PATCH), 110, 24));
    expect(lines[0]).toStartWith("/ D I F F");
    expect(lines[1]).toBe("diff --git a/math.js b/math.js");
    expect(lines[20]).toEndWith(" 100% ─");
    expect(lines[21]).toBe(
      " ↑/↓ to scroll   pgup/pgdn to page   home/end to jump",
    );
    expect(lines[22]).toBe(" q to quit");
    expect(lines[23]).toBe("");
  });

  test("rows past the end of the content are filled with a tilde", () => {
    const lines = plain(renderPager(state(PATCH), 110, 24));
    // 12 patch lines start at index 1, so the body runs dry at index 13.
    expect(lines[13]).toBe("~");
    expect(lines[19]).toBe("~");
  });

  test("the rule spans the full width whatever the percentage", () => {
    const long = state(Array.from({ length: 200 }, (_, i) => ` line ${i}`).join("\n"));
    for (const offset of [0, 40, 10_000]) {
      const rule = plain(renderPager({ ...long, offset }, 110, 40))[36] ?? "";
      expect(visibleWidth(rule)).toBe(110);
      expect(rule).toMatch(/ \d+% ─$/);
    }
  });
});

describe("pager scrolling", () => {
  const body = Array.from({ length: 100 }, (_, i) => ` line ${i}`).join("\n");

  test("percent is zero at the top and one hundred at the bottom", () => {
    expect(pagerPercent(0, 65)).toBe(0);
    expect(pagerPercent(65, 65)).toBe(100);
    expect(pagerPercent(33, 65)).toBe(51);
  });

  test("content shorter than the body reads one hundred percent", () => {
    expect(pagerMaxOffset(10, 35)).toBe(0);
    expect(pagerPercent(0, 0)).toBe(100);
  });

  test("arrows move one row and pages move one body height", () => {
    const view = state(body);
    expect(pagerScroll(view, "down", 40)).toBe(1);
    expect(pagerScroll({ ...view, offset: 10 }, "up", 40)).toBe(9);
    expect(pagerScroll(view, "page-down", 40)).toBe(35);
    expect(pagerScroll({ ...view, offset: 40 }, "page-up", 40)).toBe(5);
  });

  test("home and end jump to the ends and clamp there", () => {
    const view = state(body);
    expect(pagerScroll({ ...view, offset: 50 }, "home", 40)).toBe(0);
    expect(pagerScroll(view, "end", 40)).toBe(65);
    expect(pagerScroll({ ...view, offset: 65 }, "down", 40)).toBe(65);
    expect(pagerScroll(view, "up", 40)).toBe(0);
  });

  test("an offset past the end still renders a full, in-range frame", () => {
    const lines = renderPager({ ...state(body), offset: 9_999 }, 110, 40);
    expect(lines).toHaveLength(40);
    expect(plain(lines)[36]).toEndWith(" 100% ─");
    expect(plain(lines)[1]).toBe(" line 65");
  });
});

describe("refitting", () => {
  test("scrolling at a steady width does not re-wrap the patch", () => {
    const view = state(PATCH);
    const original = view.rows;
    refitPager(view, 110);
    // Same array identity: the rows were reused, not rebuilt per keystroke.
    expect(view.rows).toBe(original);
  });

  test("a resize re-breaks every long line for the new width", () => {
    const view = state(`+${"a".repeat(250)}`, 110);
    expect(view.rows).toHaveLength(3);
    refitPager(view, 60);
    expect(view.wrappedWidth).toBe(60);
    expect(view.rows).toHaveLength(5);
    for (const row of view.rows) {
      expect(visibleWidth(stripAnsi(row))).toBeLessThanOrEqual(60);
    }
  });
});

describe("pager content", () => {
  test("the raw patch survives, unlike the transcript's inline preview", () => {
    const rows = plain(wrapPatch(PATCH, 110));
    expect(rows).toContain("index 0604766..0bd82db 100644");
    expect(rows).toContain("--- a/math.js");
    expect(rows).toContain("+++ b/math.js");
    expect(rows).toContain("@@ -1,3 +1,7 @@");
  });

  test("file headers paint as headings, not as an addition or a deletion", () => {
    const rows = wrapPatch(PATCH, 110);
    expect(rows[2]).toContain("\x1b[1m");
    expect(rows[3]).toContain("\x1b[1m");
    expect(rows[2]).not.toContain("\x1b[31m");
    expect(rows[3]).not.toContain("\x1b[32m");
  });

  test("additions, deletions, and hunks each take their own colour", () => {
    const rows = wrapPatch(
      ["@@ -1 +1 @@", "-gone", "+kept", " same"].join("\n"),
      110,
    );
    expect(rows[0]).toContain("\x1b[36m");
    expect(rows[1]).toContain("\x1b[31m");
    expect(rows[2]).toContain("\x1b[32m");
    expect(rows[3]).toBe(" same");
  });

  test("a long line hard-wraps at the column, not at a word boundary", () => {
    const line = `+x = ${Array.from({ length: 60 }, (_, i) => i).join(" + ")}`;
    const rows = plain(wrapPatch(line, 110));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe(line.slice(0, 110).replace(/\s+$/, ""));
    expect(rows[1]).toBe(line.slice(110, 220).replace(/\s+$/, ""));
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(110);
  });

  test("a word too long to fit is split mid-token, never left overflowing", () => {
    const rows = plain(wrapPatch(`+${"a".repeat(150)}`, 110));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(110);
    expect(rows[1]).toHaveLength(41);
  });

  test("wrapped continuations keep the colour of the line they belong to", () => {
    const rows = wrapPatch(`+${"a".repeat(250)}`, 110);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toContain("\x1b[32m");
  });

  test("a clean tree still opens, on a full-height hundred-percent frame", () => {
    const lines = plain(renderPager(state(""), 110, 24));
    expect(lines[1]).toBe(PAGER_EMPTY);
    expect(lines[2]).toBe("~");
    expect(lines[20]).toEndWith(" 100% ─");
  });

  test("terminal control sequences in a patch cannot reach the screen", () => {
    const rows = plain(wrapPatch("+\x1b[2J\x1b]0;title\x07evil", 110));
    expect(rows[0]).not.toContain("\x1b");
    expect(rows[0]).toContain("evil");
  });
});

describe("pager keys", () => {
  test("page up and page down decode instead of being dropped", () => {
    expect(decodeKeys("\x1b[5~")[0]?.name).toBe("page-up");
    expect(decodeKeys("\x1b[6~")[0]?.name).toBe("page-down");
  });

  test("a page key split across two reads decodes once, not as garbage", () => {
    const decoder = new KeyDecoder();
    expect(decoder.feed("\x1b[6")).toEqual([]);
    expect(decoder.feed("~").map((key) => key.name)).toEqual(["page-down"]);
  });

  test("consecutive page keys decode in order", () => {
    expect(decodeKeys("\x1b[6~\x1b[5~").map((key) => key.name)).toEqual([
      "page-down",
      "page-up",
    ]);
  });
});
