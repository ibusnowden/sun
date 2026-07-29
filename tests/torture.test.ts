import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent } from "../src/agent/agent.ts";
import { loadConfig } from "../src/config.ts";
import { childEnvironment, runProcess } from "../src/core/process.ts";
import type {
  AgentContext,
  AgentDecision,
  ApprovalRequest,
  ModelProvider,
  RuntimeEvent,
  ToolCall,
} from "../src/core/types.ts";
import { ScriptedProvider } from "../src/model/scripted-provider.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { renderFooter, type FooterView } from "../src/tui/live.ts";
import {
  alignRight,
  renderAssistant,
  renderDiffSummary,
  renderError,
  renderFileList,
  emptyLedger,
  renderHelp,
  renderTokens,
  renderInlineDiff,
  renderInterrupted,
  renderNote,
  renderPatch,
  renderTask,
  renderToolChange,
  renderToolEnd,
} from "../src/tui/transcript.ts";
import { visibleWidth } from "../src/tui/theme.ts";
import { git, temporaryDirectory } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("bounded torture suite", () => {
  test("asks for approval for every Bash call, including harmless repeats", async () => {
    const { path } = await repository();
    const requests: ApprovalRequest[] = [];
    const commands = ["true", "printf safe", "git status --short"];
    const provider = new ScriptedProvider([
      ...commands.map((command) => ({
        kind: "tool" as const,
        call: call("bash", { command }),
      })),
      { kind: "complete", summary: "done" },
    ]);
    const agent = await Agent.create({
      config: await loadConfig(path),
      provider,
      approval: {
        confirm: async (request) => {
          requests.push(request);
          return false;
        },
      },
    });

    await agent.run("try each command");

    expect(requests.map((request) => request.command)).toEqual(commands);
    expect(
      requests.every(
        ({ reason }) => reason === "Sun asks before every shell command.",
      ),
    ).toBeTrue();
  });

  test("stops exactly at the configured maximum tool count", async () => {
    const { path } = await repository();
    const provider = new RepeatingProvider(call("read", { path: "missing" }));
    const events: RuntimeEvent[] = [];
    const agent = await Agent.create({
      config: await loadConfig(path, { maxToolCalls: 3 }),
      provider,
      approval: { confirm: async () => false },
      sink: (event) => void events.push(event),
    });

    const result = await agent.run("never stop");

    expect(provider.contexts).toHaveLength(3);
    expect(events.filter(({ type }) => type === "tool_start")).toHaveLength(3);
    expect(result).toMatchObject({
      state: "blocked",
      summary: "Stopped after 3 tool calls",
    });
  });

  test("turns a mid-decision interruption into one concise blocked result", async () => {
    const { path } = await repository();
    const controller = new AbortController();
    const events: RuntimeEvent[] = [];
    const provider: ModelProvider = {
      next: async () => {
        controller.abort();
        return { kind: "complete", summary: "must not win" };
      },
    };
    const agent = await Agent.create({
      config: await loadConfig(path),
      provider,
      approval: { confirm: async () => false },
      signal: controller.signal,
      sink: (event) => void events.push(event),
    });

    const result = await agent.run("interrupt me");

    expect(result).toMatchObject({
      state: "blocked",
      summary: "Interrupted by the user",
    });
    expect(events.filter(({ type }) => type === "interrupted")).toHaveLength(1);
    expect(events.some(({ type }) => type === "tool_start")).toBeFalse();
  });

  test("strips Git-host credentials even when additions try to restore them", () => {
    const environment = childEnvironment({
      GITHUB_TOKEN: "github",
      GH_TOKEN: "gh",
      GITLAB_TOKEN: "gitlab",
      GLAB_TOKEN: "glab",
      BITBUCKET_TOKEN: "bitbucket",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      OPENAI_API_KEY: "openai",
      AWS_SECRET_ACCESS_KEY: "aws",
      GIT_TERMINAL_PROMPT: "1",
      SAFE_VALUE: "kept",
    });

    for (const name of [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "GITLAB_TOKEN",
      "GLAB_TOKEN",
      "BITBUCKET_TOKEN",
      "SSH_AUTH_SOCK",
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
    ]) {
      expect(environment[name]).toBeUndefined();
    }
    expect(environment).toMatchObject({
      SAFE_VALUE: "kept",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/false",
      SSH_ASKPASS: "/bin/false",
    });
  });

  test("terminates a process at its timeout boundary", async () => {
    const { path } = await repository();
    const started = performance.now();
    const result = await runProcess(["bash", "-lc", "sleep 2"], {
      cwd: path,
      timeoutMs: 25,
      maxOutputBytes: 1_024,
    });

    expect(result.timedOut).toBeTrue();
    expect(result.exitCode).not.toBe(0);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("truncates combined stdout and stderr to deterministic halves", async () => {
    const { path } = await repository();
    const result = await runProcess(
      ["bash", "-lc", "printf abcdefgh; printf ABCDEFGH >&2"],
      { cwd: path, timeoutMs: 1_000, maxOutputBytes: 8 },
    );

    expect(result).toMatchObject({
      truncated: true,
      stdout: "abcd\n[TRUNCATED]",
      stderr: "ABCD\n[TRUNCATED]",
    });
  });

  test("rejects traversal for reads and writes without touching outside files", async () => {
    const { path } = await repository();
    const outside = await temporaryDirectory("sun-torture-outside-");
    cleanups.push(outside.cleanup);
    await writeFile(join(outside.path, "secret.txt"), "secret");
    const registry = await ToolRegistry.create(await loadConfig(path));

    const results = await Promise.all([
      registry.execute(call("read", { path: "../secret.txt" })),
      registry.execute(
        call("write", {
          path: "../created.txt",
          content: "escape",
          overwrite: true,
        }),
      ),
      registry.execute(call("read", { path: join(outside.path, "secret.txt") })),
    ]);

    expect(results.every((result) => !result.ok)).toBeTrue();
    expect(
      results.every((result) => result.summary.includes("escapes repository")),
    ).toBeTrue();
    expect(await Bun.file(join(outside.path, "created.txt")).exists()).toBeFalse();
  });

  test("every width-aware transcript renderer fits widths 12 and 13", () => {
    const patch = [
      "diff --git a/very/long/file.ts b/very/long/file.ts",
      "--- a/very/long/file.ts",
      "+++ b/very/long/file.ts",
      "@@ -1 +1 @@",
      "-old long content",
      "+new long content",
    ].join("\n");

    for (const width of [12, 13]) {
      const groups = [
        renderTask("a task with supercalifragilisticexpialidocious", width),
        renderAssistant("an assistant message that is deliberately long", width),
        renderToolEnd(
          call("bash", { command: "a-command-with-a-long-target" }),
          {
            ok: false,
            summary: "a very long failure summary",
            output: "a very long output line",
            exitCode: 1,
            truncated: true,
          },
          width,
        ),
        renderDiffSummary(["very/long/file.ts"], patch, width),
        renderInlineDiff(patch, width),
        renderToolChange(
          call("edit", {
            path: "very/long/file.ts",
            oldText: "old long content",
            newText: "new long content",
          }),
          {
            ok: true,
            summary: "updated",
            output: "",
            metadata: { startLine: 123_456 },
          },
          width,
        ),
        renderPatch(patch, width),
        renderInterrupted("partial response kept in context", width),
        renderNote("a deliberately long note", width),
        renderError("a deliberately long error", width),
        renderHelp(width),
        renderTokens(emptyLedger(), width),
        renderTokens(
          {
            calls: 7,
            promptTokens: 1_234_567,
            completionTokens: 98_765,
            totalTokens: 1_333_332,
            last: {
              promptTokens: 250_000,
              completionTokens: 12_345,
              totalTokens: 262_345,
              contextTokens: 262_144,
            },
            peakPromptTokens: 250_000,
            contextTokens: 262_144,
          },
          width,
        ),
        renderFileList(
          [{ path: "very/long/file.ts", action: "modified", status: "done" }],
          width,
        ),
        [alignRight("a very long left side", "right", width)],
      ];

      assertWidth(groups.flat(), width);
    }
  });

  test("every footer state fits widths 12 and 13", () => {
    for (const width of [12, 13]) {
      const frames = [
        renderFooter(footer(), width),
        renderFooter(
          footer({
            busy: true,
            activity: "a very long working activity",
            notice: "a very long notice",
          }),
          width,
        ),
        renderFooter(
          footer({
            busy: true,
            activeTool: {
              name: "bash",
              target: "a-command-with-a-very-long-target",
            },
          }),
          width,
        ),
        renderFooter(
          footer({
            input: "wide ☀ input ".repeat(8),
            cursor: 48,
          }),
          width,
        ),
        renderFooter(
          footer({
            select: {
              title: "Allow Sun to run this command?",
              subtitle: "a-command-with-a-very-long-target",
              options: [
                { label: "Yes, run it" },
                { label: "No, and let me steer instead" },
              ],
              selected: 0,
            },
          }),
          width,
        ),
      ];

      for (const frame of frames) {
        assertWidth(frame.lines, width);
        expect(frame.cursorColumn).toBeLessThanOrEqual(width);
      }
    }
  });
});

class RepeatingProvider implements ModelProvider {
  readonly contexts: AgentContext[] = [];

  constructor(readonly repeatedCall: ToolCall) {}

  async next(context: AgentContext): Promise<AgentDecision> {
    this.contexts.push(context);
    return { kind: "tool", call: this.repeatedCall };
  }
}

async function repository(): Promise<{ path: string }> {
  const temporary = await temporaryDirectory("sun-torture-");
  cleanups.push(temporary.cleanup);
  git(temporary.path, "init", "-b", "main");
  return { path: temporary.path };
}

function call(
  tool: ToolCall["tool"],
  input: Record<string, unknown>,
): ToolCall {
  return { tool, input, rationale: "torture test" };
}

function footer(overrides: Partial<FooterView> = {}): FooterView {
  return {
    busy: false,
    activity: "",
    elapsedMs: 65_000,
    totalTokens: 12_345,
    model: "a-very-long-model-name",
    mode: "work",
    repository: "/a/very/long/repository/path",
    input: "",
    cursor: 0,
    activeTool: null,
    notice: "",
    ...overrides,
  };
}

function assertWidth(lines: string[], width: number): void {
  for (const line of lines) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
}
