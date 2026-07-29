import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/tui/markdown.ts";
import {
  setColorEnabled,
  stripAnsi,
  visibleWidth,
} from "../src/tui/theme.ts";

setColorEnabled(true);

const plain = (source: string, width = 60): string[] =>
  renderMarkdown(source, width).map((line) => stripAnsi(line));

const painted = (source: string, width = 60): string =>
  renderMarkdown(source, width).join("\n");

describe("markdown", () => {
  test("leaves ordinary prose exactly as it was", () => {
    expect(plain("Reading the current implementation first.")).toEqual([
      "Reading the current implementation first.",
    ]);
  });

  test("emphasis is painted, not printed", () => {
    expect(plain("**Reading & exploring code** across projects")).toEqual([
      "Reading & exploring code across projects",
    ]);
    expect(painted("**bold**")).toBe("\x1b[1mbold\x1b[0m");
    expect(plain("read *the source* directly")).toEqual([
      "read the source directly",
    ]);
    expect(plain("call `renderMarkdown()` on it")).toEqual([
      "call renderMarkdown() on it",
    ]);
  });

  test("snake_case survives the emphasis parser", () => {
    expect(plain("use total_token_count for the budget")).toEqual([
      "use total_token_count for the budget",
    ]);
  });

  test("an inline run shares one escape pair", () => {
    // One pair per styled run, not one pair per word.
    expect(painted("**two words**")).toBe("\x1b[1mtwo words\x1b[0m");
  });

  test("bullets become glyphs with a hanging indent", () => {
    const lines = plain(
      "- **Reading & exploring code** across any of the several projects here",
      40,
    );
    expect(lines[0]).toBe("• Reading & exploring code across any of");
    expect(lines[1]).toBe("  the several projects here");
  });

  test("nested bullets step down a level", () => {
    expect(plain("- outer\n  - inner")).toEqual(["• outer", "  ◦ inner"]);
  });

  test("ordered lists keep their numbering", () => {
    expect(plain("1. install\n2. test")).toEqual(["1. install", "2. test"]);
  });

  test("headings drop their hashes and go bold", () => {
    expect(painted("## Setup")).toBe("\x1b[1mSetup\x1b[0m");
  });

  test("fenced code is indented and left verbatim", () => {
    expect(plain("text\n\n```ts\nconst a = 1;\n  const b = 2;\n```")).toEqual([
      "text",
      "",
      "  const a = 1;",
      "    const b = 2;",
    ]);
  });

  test("an unterminated fence still renders as code", () => {
    expect(plain("```\ncut off")).toEqual(["  cut off"]);
  });

  test("markdown inside a fence is not interpreted", () => {
    expect(plain("```\n- **not a bullet**\n```")).toEqual([
      "  - **not a bullet**",
    ]);
  });

  test("blockquotes get a gutter", () => {
    expect(plain("> a note")).toEqual(["│ a note"]);
  });

  test("horizontal rules span the width", () => {
    expect(plain("---", 10)).toEqual(["──────────"]);
  });

  test("tables align into columns", () => {
    const lines = plain(
      ["| Project | Status |", "| --- | ---: |", "| sun | active |"].join("\n"),
      40,
    );
    expect(lines).toEqual([
      "Project  Status",
      "───────  ──────",
      "sun      active",
    ]);
  });

  test("narrow table cells reflow instead of truncating", () => {
    const lines = plain(
      [
        "| Project | Purpose |",
        "| --- | --- |",
        "| sun | a coding agent harness |",
      ].join("\n"),
      24,
    );
    expect(lines).toEqual([
      "Project  Purpose",
      "───────  ───────────────",
      "sun      a coding agent",
      "         harness",
    ]);
  });

  test("a table too narrow for columns stacks into labelled fields", () => {
    const lines = plain(
      [
        "| Project | Status | Purpose |",
        "| --- | --- | --- |",
        "| sun | active | agent harness |",
        "| atom | paused | rl library |",
      ].join("\n"),
      16,
    );
    expect(lines).toEqual([
      "Project: sun",
      "Status: active",
      "Purpose: agent",
      "         harness",
      "────────",
      "Project: atom",
      "Status: paused",
      "Purpose: rl",
      "         library",
    ]);
  });

  test("links keep their text and trail the target", () => {
    expect(plain("see [the docs](https://example.com) now")).toEqual([
      "see the docs (https://example.com) now",
    ]);
  });

  test("no rendered line exceeds the requested width", () => {
    const source = [
      "# A heading that is quite long for the available terminal width",
      "",
      "Prose with `inline code`, **bold**, and a very long unbroken token:",
      "src/some/deeply/nested/directory/structure/with/a/long/file/name.ts",
      "",
      "- a bullet whose text runs well past the wrap column for this width",
      "  - and a nested one that also runs past the wrap column",
      "",
      "| Column A | Column B |",
      "| --- | --- |",
      "| a value that is wide | another wide value |",
      "",
      "> a quoted line that also needs to wrap somewhere sensible",
    ].join("\n");
    for (const width of [20, 32, 48, 80]) {
      for (const line of renderMarkdown(source, width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("terminal control sequences in model text are stripped", () => {
    expect(plain("before \x1b[31mred\x1b[0m after")).toEqual([
      "before red after",
    ]);
  });

  test("blank runs collapse and never bookend the block", () => {
    expect(plain("a\n\n\n\nb")).toEqual(["a", "", "b"]);
    expect(plain("\n\na\n\n")).toEqual(["a"]);
  });
});
