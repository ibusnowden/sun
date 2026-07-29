import { describe, expect, test } from "bun:test";
import { createGoal } from "../src/agent/goal.ts";
import {
  middleTruncatePath,
  renderHeader,
  renderRule,
  renderStatus,
} from "../src/tui/chrome.ts";
import {
  decodeKeys,
  KeyDecoder,
  LineEditor,
  renderFooter,
  type FooterView,
} from "../src/tui/live.ts";
import { digitSelection, moveSelection, renderSelect } from "../src/tui/select.ts";
import {
  sanitizeTerminalText,
  setColorEnabled,
  stripAnsi,
  visibleWidth,
  wrap,
} from "../src/tui/theme.ts";
import {
  describeCall,
  goalBadge,
  perFileStats,
  renderAssistant,
  renderDiffSummary,
  renderGoalCard,
  renderInlineDiff,
  renderInterrupted,
  renderNarration,
  renderPatch,
  renderTask,
  renderToolChange,
  renderToolEnd,
} from "../src/tui/transcript.ts";

setColorEnabled(true);

const plain = (lines: string[]): string => stripAnsi(lines.join("\n"));

describe("Codex UI contract", () => {
  test("the header is a content-sized box with model and directory rows", () => {
    const lines = renderHeader(
      {
        name: "Sun",
        version: "0.1.0",
        model: "glm-5.2",
        repository: "/project/inniang/sun",
        tip: "Type @ to complete a workspace path.",
      },
      100,
    );
    const text = plain(lines);

    expect(text).toContain("╭");
    expect(text).toContain("│ >_ Sun (v0.1.0)");
    expect(text).toContain("model:     glm-5.2   /model to change");
    expect(text).toContain("directory: /project/inniang/sun");
    expect(text).toContain("  Tip: Type @ to complete a workspace path.");

    // Sized to its content, not to the terminal.
    const top = lines.find((line) => line.includes("╭")) ?? "";
    expect(visibleWidth(top)).toBeLessThan(100);
  });

  test("a user message, narration, and answer each take one marker", () => {
    expect(plain(renderTask("refactor the config loader", 80))).toContain(
      "› refactor the config loader",
    );
    expect(
      plain(renderNarration("Reading the current implementation first.", 80)),
    ).toContain("• Reading the current implementation first.");
    expect(plain(renderAssistant("Done.", 80))).toContain("• Done.");
  });

  test("tool blocks name the action and carry their stat in parentheses", () => {
    const first = (lines: string[]): string => plain(lines).split("\n")[0] ?? "";

    expect(
      first(
        renderToolEnd(
          { tool: "read", rationale: "", input: { path: "src/config.ts" } },
          { ok: true, summary: "Read 84 line(s) from src/config.ts", output: "" },
          80,
        ),
      ),
    ).toBe("• Read src/config.ts (84 lines)");

    expect(
      first(
        renderToolEnd(
          {
            tool: "write",
            rationale: "",
            input: { path: "src/schema.ts", content: "a\nb\nc" },
          },
          { ok: true, summary: "Created src/schema.ts", output: "" },
          80,
        ),
      ),
    ).toBe("• Created src/schema.ts (+3 -0)");

    expect(
      first(
        renderToolEnd(
          {
            tool: "write",
            rationale: "",
            input: { path: "src/schema.ts", content: "a" },
          },
          {
            ok: true,
            summary: "Overwrote src/schema.ts",
            output: "",
            metadata: { existing: true },
          },
          80,
        ),
      ),
    ).toBe("• Overwrote src/schema.ts (+1 -0)");
  });

  test("command output hangs off a corner, then aligns under it", () => {
    const lines = plain(
      renderToolEnd(
        { tool: "bash", rationale: "", input: { command: "ls" } },
        { ok: true, summary: "", output: "first\nsecond\nthird" },
        80,
      ),
    ).split("\n");

    expect(lines[0]).toBe("• Ran ls");
    expect(lines[1]).toBe("  └ first");
    expect(lines[2]).toBe("    second");
    expect(lines[3]).toBe("    third");
  });

  test("a long command wraps onto continuation bars", () => {
    const command = `node -e "${"x".repeat(120)}"`;
    const lines = plain(
      renderToolEnd(
        { tool: "bash", rationale: "", input: { command } },
        { ok: true, summary: "", output: "" },
        60,
      ),
    ).split("\n");

    expect(lines[0]).toStartWith("• Ran ");
    expect(lines[1]).toStartWith("  │ ");
    expect(lines.every((line) => visibleWidth(line) <= 60)).toBeTrue();
  });

  test("a failed command shows the tail of its output, not a duplicated code", () => {
    const output = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const text = plain(
      renderToolEnd(
        { tool: "bash", rationale: "", input: { command: "bun test" } },
        { ok: false, summary: "Command exited with code 1", output, exitCode: 1 },
        80,
        2_400,
      ),
    );

    expect(text).toContain("• Ran bun test (exit 1)");
    expect(text).toContain("line 29");
    expect(text).not.toContain("Command exited with code 1");
  });

  test("a failing non-command tool reports its own summary", () => {
    const text = plain(
      renderToolEnd(
        { tool: "edit", rationale: "", input: { path: "a.ts", oldText: "x", newText: "y" } },
        { ok: false, summary: "Expected 1 exact match(es), found 0", output: "" },
        80,
      ),
    );

    expect(text).toContain("• Edited a.ts (failed)");
    expect(text).toContain("└ Expected 1 exact match(es), found 0");
  });

  test("elided output is counted", () => {
    const output = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    expect(
      plain(
        renderToolEnd(
          { tool: "bash", rationale: "", input: { command: "ls" } },
          { ok: true, summary: "", output },
          80,
        ),
      ),
    ).toContain("… +14 lines");
  });

  test("the turn rule spans the width", () => {
    expect(stripAnsi(renderRule(40))).toBe("─".repeat(40));
  });
});

describe("diffs", () => {
  test("inline diffs number each row and sit at output depth", () => {
    const patch = [
      "diff --git a/src/config.ts b/src/config.ts",
      "--- a/src/config.ts",
      "+++ b/src/config.ts",
      "@@ -40,2 +40,2 @@",
      " context",
      "-const timeout = 1_000",
      "+const timeout = 60_000",
    ].join("\n");

    const body = plain(renderInlineDiff(patch, 80));
    expect(body).toContain("    41 -const timeout = 1_000");
    expect(body).toContain("    41 +const timeout = 60_000");

    for (const width of [12, 13, 80]) {
      expect(
        renderInlineDiff(patch, width).every(
          (line) => visibleWidth(line) <= width,
        ),
      ).toBeTrue();
    }
  });

  test("an edit drops the lines both sides share", () => {
    // Appending to a block sends the whole block through as a removal and an
    // addition; only the new lines are worth showing.
    const call = {
      tool: "edit" as const,
      rationale: "",
      input: {
        path: "math.js",
        oldText: "}",
        newText: "}\n\nexport function subtract(a, b) {\n  return a - b\n}",
      },
    };
    const result = {
      ok: true,
      summary: "",
      output: "",
      metadata: { startLine: 3 },
    };

    const preview = plain(renderToolChange(call, result, 80));
    expect(preview).not.toContain("-}");
    expect(preview).toContain("    5 +export function subtract(a, b) {");

    // The headline counts the same trimmed change the rows show.
    expect(plain(renderToolEnd(call, result, 80))).toContain(
      "• Edited math.js (+4 -0)",
    );
  });

  test("a large replacement previews both sides, not just the deletions", () => {
    const preview = plain(
      renderToolChange(
        {
          tool: "edit",
          rationale: "",
          input: {
            path: "src/config.ts",
            oldText: Array.from({ length: 13 }, (_, i) => `old ${i}`).join("\n"),
            newText: Array.from({ length: 15 }, (_, i) => `new ${i}`).join("\n"),
          },
        },
        { ok: true, summary: "", output: "", metadata: { startLine: 1 } },
        80,
      ),
    );

    expect(preview).toContain("-old 0");
    expect(preview).toContain("+new 0");
    expect(preview).toMatch(/changed lines/);
  });

  test("diff summaries count additions and deletions per file", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      "-old",
      "+new",
      "+extra",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n");

    const stats = perFileStats(patch);
    expect(stats.get("src/a.ts")).toEqual({ additions: 2, deletions: 1 });
    expect(stats.get("src/b.ts")).toEqual({ additions: 1, deletions: 1 });

    const summary = plain(renderDiffSummary(["src/a.ts", "src/b.ts"], patch, 80));
    expect(summary).toContain("2 files");
    expect(summary).toContain("+3");
    expect(summary).toContain("-2");

    const body = plain(renderPatch(patch, 80));
    expect(body).toContain("@@ -1,2 +1,3 @@");
    expect(body).toContain("+extra");
    expect(body).not.toContain("index ");
  });

  test("call descriptions stay tool-specific", () => {
    expect(
      describeCall({ tool: "bash", rationale: "", input: { command: "rg ttl src" } }),
    ).toBe("rg ttl src");
    expect(
      describeCall({ tool: "write", rationale: "", input: { path: "src/new.ts" } }),
    ).toBe("src/new.ts");
  });

  test("an interruption reads as one line", () => {
    expect(
      plain(renderInterrupted("partial response kept in context", 80)),
    ).toContain("• Interrupted … partial response kept in context");
  });
});

describe("footer", () => {
  test("the idle footer is a prompt and a status line", () => {
    const frame = renderFooter(view({ placeholder: "Explain this codebase" }), 72);
    const text = plain(frame.lines);

    expect(text).toContain("› Explain this codebase");
    expect(text).toContain("glm-5.2 · /repo");
    expect(frame.lines.every((line) => visibleWidth(line) <= 72)).toBeTrue();
    expect(frame.cursorRow).toBe(0);
    expect(frame.cursorColumn).toBe(3);
  });

  test("the working row states the elapsed time and how to stop", () => {
    const text = plain(
      renderFooter(view({ busy: true, elapsedMs: 22_000 }), 72).lines,
    );

    expect(text).toContain("• Working (22s • esc to interrupt)");
  });

  test("an active tool replaces the verb with what it is doing", () => {
    const text = plain(
      renderFooter(
        view({
          busy: true,
          elapsedMs: 4_000,
          activeTool: { name: "bash", target: "bun test" },
        }),
        72,
      ).lines,
    );

    expect(text).toContain("• Running bun test (4s • esc to interrupt)");
  });

  test("streamed reasoning shows only its tail, and only while busy", () => {
    const reasoning = Array.from(
      { length: 12 },
      (_, i) => `thought number ${i} about the failing assertion`,
    ).join(" ");

    const working = plain(renderFooter(view({ busy: true, reasoning }), 72).lines);
    expect(working).toContain("thought number 11");
    expect(working).not.toContain("thought number 0 ");

    const idle = plain(renderFooter(view({ reasoning }), 72).lines);
    expect(idle).not.toContain("thought number");
  });

  test("the completion menu hangs below the composer and hides the status", () => {
    const frame = renderFooter(
      view({
        input: "/g",
        cursor: 2,
        completion: {
          trigger: "/",
          selected: 0,
          items: [
            { value: "goal", detail: "set or view the goal" },
            { value: "diff", detail: "print the full working diff" },
          ],
        },
      }),
      72,
    );
    const lines = plain(frame.lines).split("\n");
    const composer = lines.findIndex((line) => line.startsWith("› /g"));
    const menu = lines.findIndex((line) => line.includes("/goal"));

    expect(composer).toBeGreaterThanOrEqual(0);
    expect(menu).toBeGreaterThan(composer);
    expect(plain(frame.lines)).not.toContain("glm-5.2 · /repo");
  });

  test("a modal choice owns the whole live region", () => {
    const frame = renderFooter(
      view({
        select: {
          title: "Allow Sun to run this command?",
          subtitle: "rm -rf ./dist",
          options: [{ label: "Yes, run it" }, { label: "No, skip it" }],
          selected: 0,
        },
      }),
      80,
    );
    const text = plain(frame.lines);

    expect(text).toContain("Allow Sun to run this command?");
    expect(text).toContain("› 1. Yes, run it");
    expect(text).toContain("  2. No, skip it");
    expect(text).toContain("Press enter to confirm or esc to go back");
    expect(text).not.toContain("glm-5.2");
  });

  test("a goal badge rides on the status line", () => {
    const goal = { ...createGoal("ship the parser", 400_000), turns: 3, tokensUsed: 81_500 };
    const text = plain(
      renderFooter(view({ goal: goalBadge(goal), totalTokens: 96_200 }), 100).lines,
    );

    expect(text).toContain("goal active · 3 turns · 81.5k/400k");
    expect(text).toContain("96.2k tokens");
  });

  test("an unbudgeted goal does not repeat the session token count", () => {
    const goal = { ...createGoal("ship the parser"), turns: 4, tokensUsed: 37_900 };
    const badge = goalBadge(goal);
    const text = plain(
      renderFooter(view({ goal: badge, totalTokens: 37_900 }), 100).lines,
    );

    expect(badge).toBe("goal active · 4 turns");
    expect(text.split("37.9k")).toHaveLength(2);
  });

  test("the caret tracks a long input by scrolling the visible window", () => {
    const input = "x".repeat(200);
    const frame = renderFooter(view({ input, cursor: input.length }), 60);

    expect(frame.cursorColumn).toBeLessThanOrEqual(60);
    expect(frame.lines.every((line) => visibleWidth(line) <= 60)).toBeTrue();
  });

  test("live rows reflow without overflowing narrow or wide terminals", () => {
    for (const width of [20, 32, 80, 180]) {
      const frames = [
        renderFooter(
          view({
            repository: "/project/inniang/a/very/long/workspace/path",
            select: {
              title: "Allow Sun to run this command?",
              subtitle: "rm -rf ./dist/with/a/very/long/generated/path",
              options: [
                { label: "Yes, run it", description: "runs inside the sandbox" },
                { label: "No, skip it" },
              ],
              selected: 0,
            },
          }),
          width,
        ),
        renderFooter(
          view({
            busy: true,
            activeTool: {
              name: "bash",
              target: "bun test tests/with/a/very/long/path.test.ts",
            },
          }),
          width,
        ),
      ];
      expect(
        frames.every((frame) =>
          frame.lines.every((line) => visibleWidth(line) <= width),
        ),
      ).toBeTrue();
    }
  });

  test("a deep workspace path keeps the status row to one line", () => {
    const deep =
      "/tmp/claude-63735/-project-inniang/58b39a11-f29e-4a3d/scratchpad/demo";
    const frame = renderFooter(view({ repository: deep }), 80);

    expect(frame.lines.filter((line) => line.includes("glm-5.2"))).toHaveLength(1);
    expect(frame.lines.every((line) => visibleWidth(line) <= 80)).toBeTrue();
  });
});

describe("chrome helpers", () => {
  test("a path is shortened from the middle, keeping head and tail", () => {
    const short = middleTruncatePath(
      "/tmp/claude-63735/-project-inniang/dc4ef169/scratchpad/codexbox",
      40,
    );

    expect(short).toStartWith("/tmp/claude-63735/");
    expect(short).toEndWith("scratchpad/codexbox");
    expect(short).toContain("…");
    expect(visibleWidth(short)).toBeLessThanOrEqual(40);
  });

  test("a path that already fits is untouched", () => {
    expect(middleTruncatePath("/repo/src", 40)).toBe("/repo/src");
  });

  test("the status badge is dropped before the workspace is", () => {
    const narrow = plain(
      renderStatus(
        {
          model: "glm-5.2",
          repository: "/repo",
          totalTokens: 96_200,
          goal: "goal active · 3 turns",
        },
        24,
      ),
    );

    expect(narrow).toContain("glm-5.2");
    expect(narrow).not.toContain("goal active");
  });
});

describe("selection", () => {
  test("rows are numbered, the current one is marked, and descriptions align", () => {
    const text = plain(
      renderSelect(
        {
          title: "Update command approvals",
          subtitle: "Commands run in the sandbox either way.",
          options: [
            { label: "Ask every time", description: "Sun pauses at each command.", current: true },
            { label: "Run without asking", description: "Straight to the sandbox." },
          ],
          selected: 1,
        },
        80,
      ),
    );

    expect(text).toContain("  1. Ask every time (current)");
    expect(text).toContain("› 2. Run without asking");
    expect(text).toContain("Sun pauses at each command.");
  });

  test("the highlight wraps in both directions", () => {
    expect(moveSelection(0, 3, -1)).toBe(2);
    expect(moveSelection(2, 3, 1)).toBe(0);
    expect(moveSelection(0, 0, 1)).toBe(0);
  });

  test("a digit picks a row only when the row exists", () => {
    expect(digitSelection("2", 3)).toBe(1);
    expect(digitSelection("9", 3)).toBeNull();
    expect(digitSelection("a", 3)).toBeNull();
    expect(digitSelection("0", 3)).toBeNull();
  });
});

describe("goal card", () => {
  test("the card states the objective, turns, tokens, and status", () => {
    const goal = {
      ...createGoal("make the flaky auth test pass", 416_000),
      turns: 3,
      tokensUsed: 81_485,
    };
    const text = plain(renderGoalCard(goal, 80));

    expect(text).toContain("• Goal · active");
    expect(text).toContain("objective  make the flaky auth test pass");
    expect(text).toContain("turns      3");
    expect(text).toContain("tokens     81.5k / 416k");
  });

  test("a finished goal reads as achieved", () => {
    const goal = { ...createGoal("ship it"), status: "complete" as const };
    expect(plain(renderGoalCard(goal, 80))).toContain("• Goal · achieved");
  });

  test("a goal with no budget shows what it has spent", () => {
    const goal = { ...createGoal("ship it"), tokensUsed: 2_500 };
    expect(plain(renderGoalCard(goal, 80))).toContain("tokens     2.5k");
  });
});

describe("input", () => {
  test("decodes control keys, arrows, and bracketed paste", () => {
    expect(decodeKeys("hi").map((key) => key.text)).toEqual(["h", "i"]);
    expect(decodeKeys("\x1b[A")[0]?.name).toBe("up");
    expect(decodeKeys("\x1b")[0]?.name).toBe("escape");
    expect(decodeKeys("\r")[0]?.name).toBe("enter");
    expect(decodeKeys("\x03")[0]?.name).toBe("interrupt");

    const paste = decodeKeys("\x1b[200~first\nsecond\x1b[201~");
    expect(paste).toHaveLength(1);
    expect(paste[0]?.name).toBe("paste");
    expect(paste[0]?.text).toBe("first\nsecond");
  });

  test("holds partial escape sequences until the next input chunk", () => {
    const decoder = new KeyDecoder();
    expect(decoder.feed("\x1b[")).toEqual([]);
    expect(decoder.feed("A")[0]?.name).toBe("up");
  });

  test("editing, history, and word deletion behave like a shell prompt", () => {
    const editor = new LineEditor();
    editor.insert("fix the tests");
    editor.killWord();
    expect(editor.value).toBe("fix the");

    editor.home();
    editor.insert("please ");
    expect(editor.value).toBe("please fix the");
    expect(editor.cursor).toBe(7);

    expect(editor.submit()).toBe("please fix the");
    expect(editor.value).toBe("");

    editor.previous();
    expect(editor.value).toBe("please fix the");
    editor.next();
    expect(editor.value).toBe("");
  });

  test("a pasted newline stays in one multi-line submission", () => {
    const editor = new LineEditor();
    editor.insert("first\nsecond");
    expect(editor.value).toBe("first\nsecond");
    expect(editor.submit()).toBe("first\nsecond");
  });

  test("multi-line input renders continuation rows and keeps the caret visible", () => {
    const input = "first line\nsecond line";
    const frame = renderFooter(
      view({ input, cursor: input.indexOf("second") + 3 }),
      48,
    );
    const text = plain(frame.lines);

    expect(text).toContain("first line");
    expect(text).toContain("second line");
    expect(frame.cursorRow).toBeLessThan(frame.lines.length - 1);
  });
});

describe("layout helpers", () => {
  test("terminal controls are removed while visible text is preserved", () => {
    const hostile =
      "before\x1b[2Jafter\x1b]0;fake title\x07shown\x07!\rnext\x9b31mred";
    const clean = sanitizeTerminalText(hostile);

    expect(clean).toBe("beforeaftershown! nextred");
    expect(clean).not.toContain("\x1b");
    expect(clean).not.toContain("\x07");
    expect(clean).not.toContain("\r");
    expect(plain(renderAssistant(hostile, 80))).toContain(
      "beforeaftershown! nextred",
    );
  });

  test("an approval command cannot inject cursor or screen controls", () => {
    const frame = renderFooter(
      view({
        select: {
          title: "Allow Sun to run this command?",
          subtitle: "printf safe\x1b[2J\x1b]0;fake\x07",
          options: [{ label: "Yes, run it" }],
          selected: 0,
        },
      }),
      80,
    );
    const rendered = frame.lines.join("\n");

    expect(rendered).not.toContain("\x1b[2J");
    expect(rendered).not.toContain("\x1b]0;");
    expect(plain(frame.lines)).toContain("printf safe");
  });

  test("wrap breaks long words and keeps the requested width", () => {
    const lines = wrap(`short ${"y".repeat(30)} tail`, 12);
    expect(lines.every((line) => visibleWidth(line) <= 12)).toBeTrue();
    expect(lines.join(" ")).toContain("tail");
  });
});

function view(overrides: Partial<FooterView> = {}): FooterView {
  return {
    busy: false,
    activity: "",
    elapsedMs: 0,
    totalTokens: 0,
    model: "glm-5.2",
    mode: "work",
    repository: "/repo",
    input: "",
    cursor: 0,
    activeTool: null,
    notice: "",
    ...overrides,
  };
}
