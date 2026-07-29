import { describe, expect, test } from "bun:test";
import type { RunResult, ToolCall } from "../src/core/types.ts";
import { setColorEnabled, stripAnsi } from "../src/tui/theme.ts";
import { TerminalUI } from "../src/tui/terminal-ui.ts";

function harness() {
  const chunks: string[] = [];
  const ui = new TerminalUI({
    version: "0.1.0",
    mode: "work",
    model: "glm-5.2",
    repository: "/repo",
    output: { write: (chunk: string) => void chunks.push(chunk) },
  });
  // Cursor movement and erases are terminal plumbing; assertions read the text.
  const text = (): string =>
    stripAnsi(chunks.join("")).replace(/\r/g, "").replace(/\x1b\[\?[0-9]+[hl]/g, "");
  return { ui, text, chunks };
}

const EDIT: ToolCall = {
  tool: "edit",
  rationale: "Minutes must be multiplied by 60_000",
  input: {
    path: "app.ts",
    oldText: "minutes * 1000",
    newText: "minutes * 60_000",
    expectedMatches: 1,
  },
};

const PATCH = [
  "diff --git a/app.ts b/app.ts",
  "--- a/app.ts",
  "+++ b/app.ts",
  "@@ -1 +1 @@",
  "-const ttl = minutes * 1000",
  "+const ttl = minutes * 60_000",
].join("\n");

function result(): RunResult {
  return {
    state: "complete",
    summary: "Corrected the TTL multiplier.",
    filesChanged: ["app.ts"],
  };
}

describe("TerminalUI", () => {
  test("projects a whole run into a readable transcript", () => {
    const { ui, text } = harness();
    ui.start();
    ui.beginRun("Fix refresh tokens expiring early");
    ui.observer.onPhaseStart?.("decide");
    ui.observer.onThinking?.("decide", "minutes are multiplied by 1000, not 60000");
    ui.observer.onPhaseEnd?.("decide", {
      durationMs: 4_000,
      usage: {
        promptTokens: 26_214,
        completionTokens: 120,
        totalTokens: 26_334,
        contextTokens: 262_144,
      },
      failed: false,
    });
    ui.handle({ type: "tool_start", call: EDIT });
    ui.handle({
      type: "tool_end",
      call: EDIT,
      result: { ok: true, summary: "Replaced 1 exact match(es) in app.ts", output: "" },
    });
    ui.handle({ type: "diff", files: ["app.ts"], patch: PATCH });
    ui.endRun(result());
    ui.stop();

    const transcript = text();
    expect(transcript).toContain(">_ Sun (v0.1.0)");
    expect(transcript).toContain("› Fix refresh tokens expiring early");
    expect(transcript).toContain("• Minutes must be multiplied by 60_000");
    expect(transcript).toContain("• Edited app.ts (+1 -1)");
    expect(transcript).toContain("-minutes * 1000");
    expect(transcript).toContain("+minutes * 60_000");
    expect(transcript).toContain("• Corrected the TTL multiplier.");
    expect(transcript).not.toContain("PLAN");
    expect(transcript).not.toContain("REVIEW");
    expect(transcript).not.toContain("$0.00");
  });

  test("model reasoning is shown live and does not survive the turn", () => {
    const { ui, text } = harness();
    ui.start();
    ui.beginRun("Fix refresh tokens expiring early");
    ui.observer.onPhaseStart?.("decide");
    ui.observer.onThinking?.("decide", "minutes are multiplied by 1000, not 60000");

    expect(text()).toContain("minutes are multiplied by 1000");

    // Narration replaces it as soon as the model commits to an action.
    ui.handle({ type: "tool_start", call: EDIT });
    const live = text().split("• Minutes must be multiplied").at(-1) ?? "";
    expect(live).not.toContain("minutes are multiplied by 1000");
    ui.stop();
  });

  test("typed input becomes the next task", async () => {
    const { ui } = harness();
    ui.start();
    const pending = ui.readTask();
    ui.feedKeys("fix the ttl bug\r");
    expect(await pending).toBe("fix the ttl bug");
    ui.stop();
  });

  test("a running turn shows elapsed time and how to stop it", () => {
    const { ui, text } = harness();
    ui.start();
    ui.beginRun("hello sun");

    expect(text()).toContain("• Working (0s • esc to interrupt)");
    ui.stop();
  });

  test("a completed tool block closes with its own blank row", () => {
    // Scrollback is written one block per chunk, so a block's trailing blank
    // row is visible as a chunk that ends on an empty line.
    const { ui, chunks } = harness();
    const read: ToolCall = {
      tool: "read",
      rationale: "Reading the current implementation first.",
      input: { path: "src/config.ts" },
    };
    ui.start();
    ui.beginRun("refactor the config loader");
    ui.handle({ type: "tool_start", call: read });
    ui.handle({
      type: "tool_end",
      call: read,
      result: {
        ok: true,
        summary: "Read 84 line(s) from src/config.ts",
        output: "",
      },
    });
    ui.stop();

    const block = chunks.find((chunk) =>
      stripAnsi(chunk).includes("• Read src/config.ts"),
    );
    expect(block).toBeDefined();
    const rows = stripAnsi(block ?? "").split("\n");
    expect(rows[0]).toBe("• Read src/config.ts (84 lines)");
    // One trailing blank row, never two.
    expect(rows.slice(1)).toEqual(["", ""]);
  });

  test("the same repository diff is not printed twice", () => {
    const { ui, text } = harness();
    ui.start();
    ui.beginRun("fix it");
    ui.handle({ type: "diff", files: ["app.ts"], patch: PATCH });
    ui.handle({ type: "diff", files: ["app.ts"], patch: PATCH });

    expect(text().split("-const ttl = minutes * 1000")).toHaveLength(2);
    ui.stop();
  });

  test("typing during a run queues steering instead of starting a task", () => {
    const { ui, text } = harness();
    ui.start();
    ui.beginRun("first task");
    ui.feedKeys("also update the tests\r");

    expect(ui.drainInput()).toEqual(["also update the tests"]);
    expect(text()).toContain("› also update the tests");
    ui.stop();
  });

  test("escape interrupts the run and the agent sees an aborted signal", () => {
    const { ui, text } = harness();
    ui.start();
    const signal = ui.beginRun("long task");
    expect(signal.aborted).toBeFalse();

    ui.feedKeys("\x1b");
    expect(signal.aborted).toBeTrue();
    expect(text()).toContain("interrupting at the next safe boundary");
    ui.stop();
  });

  test("ctrl+c clears input, then exits on a second empty press", () => {
    const { ui, text } = harness();
    ui.start();
    ui.feedKeys("half a thought");
    ui.feedKeys("\x03");
    expect(ui.exitRequested).toBeFalse();

    ui.feedKeys("\x03");
    expect(text()).toContain("press ctrl+c again to exit");
    expect(ui.exitRequested).toBeFalse();

    ui.feedKeys("\x03");
    expect(ui.exitRequested).toBeTrue();
    ui.stop();
  });

  test("an approval is a numbered choice answered from the keyboard stream", async () => {
    const { ui, text } = harness();
    ui.start();
    ui.beginRun("install a dependency");
    const approved = ui.confirm({
      action: "bash: add the dependency",
      reason: "dependency change",
      command: "bun add zod",
    });
    expect(text()).toContain("Allow Sun to run this command?");
    expect(text()).toContain("bun add zod");
    expect(text()).toContain("› 1. Yes, run it");

    ui.feedKeys("1");
    expect(await approved).toBeTrue();
    ui.stop();
  });

  test("the second choice approves the same tool for the rest of the session", async () => {
    const { ui, text } = harness();
    const request = {
      action: "bash: install the new dependency",
      reason: "dependency change",
      command: "bun add zod",
    };
    ui.start();
    ui.beginRun("install a dependency");
    const first = ui.confirm(request);
    expect(text()).toContain("stop asking about bash this session");
    ui.feedKeys("2");

    expect(await first).toBeTrue();
    // The second request never opens a card at all.
    expect(await ui.confirm(request)).toBeTrue();
    ui.stop();
  });

  test("declining seeds replacement steering instead of running the command", async () => {
    const { ui } = harness();
    ui.start();
    ui.beginRun("remove generated output");
    const approval = ui.confirm({
      action: "bash: remove generated output",
      reason: "destructive command",
      command: "rm -rf ./dist",
    });
    ui.feedKeys("3");

    expect(await approval).toBeFalse();
    ui.feedKeys("with something safer\r");
    expect(ui.drainInput()).toEqual([
      "Use this instead of `rm -rf ./dist`: with something safer",
    ]);
    ui.stop();
  });

  test("escape at an approval skips the command", async () => {
    const { ui } = harness();
    ui.start();
    ui.beginRun("remove generated output");
    const approval = ui.confirm({
      action: "bash: remove generated output",
      reason: "destructive command",
      command: "rm -rf ./dist",
    });
    ui.feedKeys("\x1b");

    expect(await approval).toBeFalse();
    ui.stop();
  });

  test("an interrupted run keeps a concise marker instead of a blocked card", () => {
    const { ui, text } = harness();
    ui.start();
    ui.beginRun("long migration");
    ui.handle({ type: "interrupted", reason: "Interrupted by the user" });
    ui.endRun({
      ...result(),
      state: "blocked",
      summary: "Interrupted by the user",
    });

    expect(text()).toContain("• Interrupted");
    expect(text()).toContain("partial response kept in context");
    expect(text()).not.toContain("BLOCKED");
    ui.stop();
  });

  test("a blocked run renders one concise failure", () => {
    const { ui, text } = harness();
    ui.start();
    ui.beginRun("inspect a missing service");
    ui.endRun({
      state: "blocked",
      summary: "The model endpoint is unavailable.",
      filesChanged: [],
    });

    expect(text()).toContain("• The model endpoint is unavailable.");
    ui.stop();
  });

  test("a finished turn is closed with a rule", () => {
    const { ui, text } = harness();
    ui.start();
    ui.beginRun("task");
    ui.endRun(result());

    expect(text()).toContain("─────");
    ui.stop();
  });

  test("slash commands answer locally without touching the agent", () => {
    const { ui, text } = harness();
    ui.start();
    ui.beginRun("task");
    ui.handle({ type: "diff", files: ["app.ts"], patch: PATCH });
    ui.feedKeys("/diff\r");
    ui.feedKeys("/files\r");
    ui.feedKeys("/nope\r");

    const transcript = text();
    expect(transcript).toContain("@@ -1 +1 @@");
    expect(transcript).toContain("No files touched yet.");
    expect(transcript).toContain("Unknown command /nope");
    expect(ui.drainInput()).toEqual([]);
    ui.stop();
  });

  test("/goal without a controller says so instead of failing", () => {
    const { ui, text } = harness();
    ui.start();
    ui.feedKeys("/goal ship the parser\r");

    expect(text()).toContain("Goals need an interactive session.");
    ui.stop();
  });

  test("/goal sets an objective, shows the card, and starts the loop", async () => {
    const chunks: string[] = [];
    const stored: Array<{ objective: string; tokenBudget: number | null }> = [];
    const ui = new TerminalUI({
      version: "0.1.0",
      mode: "work",
      model: "glm-5.2",
      repository: "/repo",
      output: { write: (chunk: string) => void chunks.push(chunk) },
      goal: {
        current: () => null,
        set: async (objective, tokenBudget) => {
          stored.push({ objective, tokenBudget });
          return {
            objective,
            status: "active",
            tokenBudget,
            tokensUsed: 0,
            turns: 0,
            blockedStreak: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
        },
        clear: async () => {},
        pause: async () => null,
        resume: async () => null,
      },
    });
    ui.start();
    const pending = ui.readTask();
    ui.feedKeys("/goal make the flaky auth test pass --budget 250k\r");

    // The empty task is the session loop's cue to pursue the goal.
    expect(await pending).toBe("");
    expect(stored).toEqual([
      { objective: "make the flaky auth test pass", tokenBudget: 250_000 },
    ]);
    expect(stripAnsi(chunks.join(""))).toContain("• Goal · active");
    ui.stop();
  });

  test("a sub-command word only counts as the whole argument", async () => {
    // "/goal clear the caches" is an objective about caches, not a request to
    // forget the goal.
    const calls: string[] = [];
    const objectives: string[] = [];
    const goal = {
      objective: "",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 0,
      turns: 0,
      blockedStreak: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const ui = new TerminalUI({
      version: "0.1.0",
      mode: "work",
      model: "glm-5.2",
      repository: "/repo",
      output: { write: () => {} },
      goal: {
        current: () => goal,
        set: async (objective) => {
          calls.push("set");
          objectives.push(objective);
          return { ...goal, objective };
        },
        clear: async () => void calls.push("clear"),
        pause: async () => {
          calls.push("pause");
          return goal;
        },
        resume: async () => {
          calls.push("resume");
          return goal;
        },
      },
    });
    ui.start();
    ui.feedKeys("/goal clear the caches before each run\r");
    await Bun.sleep(1);
    ui.feedKeys("/goal clear\r");
    await Bun.sleep(1);

    expect(calls).toEqual(["set", "clear"]);
    expect(objectives).toEqual(["clear the caches before each run"]);
    ui.stop();
  });

  test("a goal set between runs is still delivered to the next readTask", async () => {
    // The hand-off queues the empty string, which is falsy: it has to survive
    // the queue anyway, or setting a goal outside a wait silently does nothing.
    const active = {
      objective: "ship the parser",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 0,
      turns: 0,
      blockedStreak: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const ui = new TerminalUI({
      version: "0.1.0",
      mode: "work",
      model: "glm-5.2",
      repository: "/repo",
      output: { write: () => {} },
      goal: {
        current: () => active,
        set: async () => active,
        clear: async () => {},
        pause: async () => active,
        resume: async () => active,
      },
    });
    ui.start();
    // No readTask is waiting yet, so the hand-off has to be queued.
    ui.feedKeys("/goal ship the parser\r");

    expect(await ui.readTask()).toBe("");
    ui.stop();
  });

  test("a remembered approval never covers a publish", async () => {
    const { ui, text } = harness();
    ui.start();
    ui.beginRun("ship it");

    // Teach the session to stop asking about bash.
    const bash = ui.confirm({
      action: "bash: install the new dependency",
      reason: "dependency change",
      command: "bun add zod",
    });
    ui.feedKeys("2");
    expect(await bash).toBeTrue();

    // Publishing leaves the sandbox, so it still opens a card, and the card
    // offers no way to stop being asked.
    const publish = ui.confirm({
      action: "publish: origin/main",
      reason: "Publishing runs Git outside Sun's sandbox.",
      command: "git push origin abc123def456:refs/heads/main",
      detail: ["Remote   origin → git@example.invalid:me/repo.git"],
      alwaysAsk: true,
    });
    const card = text();
    expect(card).toContain("Allow Sun to publish outside the sandbox?");
    expect(card).toContain("git@example.invalid:me/repo.git");
    expect(card).toContain("Sun asks every time");
    expect(card).not.toContain("stop asking about publish");

    ui.feedKeys("1");
    expect(await publish).toBeTrue();
    ui.stop();
  });

  test("/tokens totals the session and reports the peak against the window", () => {
    const { ui, text } = harness();
    ui.start();
    ui.beginRun("do the work");
    ui.handle({
      type: "model_end",
      phase: "decide",
      durationMs: 1_000,
      usage: {
        promptTokens: 8_000,
        completionTokens: 500,
        totalTokens: 8_500,
        contextTokens: 100_000,
      },
      failed: false,
    });
    ui.handle({
      type: "model_end",
      phase: "decide",
      durationMs: 1_000,
      usage: {
        promptTokens: 12_000,
        completionTokens: 1_500,
        totalTokens: 13_500,
        contextTokens: 100_000,
      },
      failed: false,
    });

    ui.feedKeys("/tokens\r");
    const shown = text();
    expect(shown).toContain("22k over 2 model calls");
    expect(shown).toContain("20k in, 2k out");
    expect(shown).toContain("13.5k · 12k in, 1.5k out");
    expect(shown).toContain("11k per call");
    // The window is spent by the largest prompt, not the running total.
    expect(shown).toContain("12k peak prompt of 100k (12%)");
    ui.stop();
  });

  test("/tokens says so plainly before any model call", () => {
    const { ui, text } = harness();
    ui.start();
    ui.feedKeys("/tokens\r");
    expect(text()).toContain("No model calls yet");
    ui.stop();
  });

  test("a finished command takes a green bullet and a coloured command", () => {
    // The suite runs without a TTY, so colour is off by default.
    setColorEnabled(true);
    const { ui, chunks } = harness();
    ui.start();
    ui.beginRun("run the tests");
    const call: ToolCall = {
      tool: "bash",
      rationale: "Running the focused checks.",
      input: { command: "bun test" },
    };
    ui.handle({ type: "tool_start", call });
    ui.handle({
      type: "tool_end",
      call,
      result: { ok: true, summary: "exit 0", output: "209 pass", exitCode: 0 },
    });
    const raw = chunks.join("");
    // Green bullet, then the command in the running colour rather than plain.
    expect(raw).toContain("\x1b[32m•\x1b[0m");
    expect(raw).toContain("\x1b[36m bun test\x1b[0m");

    ui.handle({ type: "tool_start", call });
    ui.handle({
      type: "tool_end",
      call,
      result: { ok: false, summary: "exit 1", output: "1 fail", exitCode: 1 },
    });
    // A failure keeps the red bullet it always had.
    expect(chunks.join("")).toContain("\x1b[31m•\x1b[0m");
    ui.stop();
    setColorEnabled(false);
  });

  test("a file path stays a heading rather than taking the command colour", () => {
    setColorEnabled(true);
    const { ui, chunks } = harness();
    ui.start();
    const call: ToolCall = {
      tool: "read",
      rationale: "Reading it.",
      input: { path: "src/app.ts" },
    };
    ui.beginRun("read it");
    ui.handle({
      type: "tool_end",
      call,
      result: { ok: true, summary: "Read 12 line(s) from src/app.ts", output: "" },
    });
    const raw = chunks.join("");
    expect(raw).toContain("\x1b[32m•\x1b[0m");
    expect(raw).not.toContain("\x1b[36m src/app.ts");
    ui.stop();
    setColorEnabled(false);
  });

  test("/tokens attributes cost to the tool that produced the output", () => {
    const { ui, text } = harness();
    ui.start();
    ui.beginRun("do the work");
    for (const [tool, tokens] of [
      ["bash", 9_000],
      ["read", 3_000],
      ["bash", 1_000],
    ] as const) {
      ui.handle({
        type: "tool_end",
        call: { tool, rationale: "r", input: {} },
        result: { ok: true, summary: "ok", output: "", outputTokens: tokens },
      });
    }

    ui.feedKeys("/tokens\r");
    const shown = text();
    expect(shown).toContain("By tool");
    // Heaviest first: bash's two calls outweigh read's one.
    expect(shown.indexOf("bash")).toBeLessThan(shown.indexOf("read"));
    expect(shown).toContain("10k from 2 calls");
    expect(shown).toContain("3k from 1 call");
    ui.stop();
  });

  test("/plan toggles the mode and shows it in the footer", () => {
    const { ui, text } = harness();
    ui.start();
    expect(ui.mode).toBe("work");

    ui.feedKeys("/plan\r");
    expect(ui.mode).toBe("plan");
    expect(text()).toContain("Plan mode");
    expect(text()).toContain("PLAN");

    ui.feedKeys("/plan\r");
    expect(ui.mode).toBe("work");
    expect(text()).toContain("Work mode");
    ui.stop();
  });
});
