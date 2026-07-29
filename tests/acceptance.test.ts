import { afterEach, describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Agent } from "../src/agent/agent.ts";
import { loadConfig } from "../src/config.ts";
import { runProcess } from "../src/core/process.ts";
import type { ApprovalRequest, RuntimeEvent } from "../src/core/types.ts";
import { ScriptedProvider } from "../src/model/scripted-provider.ts";
import {
  renderFooter,
  type FooterView,
} from "../src/tui/live.ts";
import { stripAnsi, visibleWidth } from "../src/tui/theme.ts";
import { TerminalUI } from "../src/tui/terminal-ui.ts";
import { git, temporaryDirectory } from "./helpers.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const CLI = join(PROJECT_ROOT, "src", "cli.ts");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("installed CLI acceptance", () => {
  test("the package exposes an executable sun command with local help and version", async () => {
    const manifest = JSON.parse(
      await readFile(join(PROJECT_ROOT, "package.json"), "utf8"),
    ) as { name: string; version: string; bin?: Record<string, string> };
    const mode = (await stat(CLI)).mode;

    expect(manifest.bin?.sun).toBe("./src/cli.ts");
    expect(mode & 0o111).not.toBe(0);

    const version = await invokeCli("--version");
    expect(version.exitCode).toBe(0);
    expect(version.stderr).toBe("");
    expect(version.stdout.trim()).toBe(manifest.version);

    const help = await invokeCli("--help");
    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain(`Sun ${manifest.version}`);
    expect(help.stdout).toContain("sun init [directory]");
    expect(help.stdout).toContain("read  edit  write  bash");
  });

  test("sun init is offline, idempotent, and preserves an existing config", async () => {
    const temporary = await temporaryDirectory("sun-acceptance-init-");
    cleanups.push(temporary.cleanup);

    const first = await invokeCli("init", temporary.path);
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toContain(join(temporary.path, ".agent"));

    const configPath = join(temporary.path, ".agent", "config.toml");
    const generated = await readFile(configPath, "utf8");
    expect(generated).toContain('provider = "openai-compatible"');
    expect(generated).toContain('model = "glm-5.2"');

    const customized = generated.replace(
      'model = "glm-5.2"',
      'model = "offline-test-model"',
    );
    await writeFile(configPath, customized);

    const second = await invokeCli("init", temporary.path);
    expect(second.exitCode).toBe(0);
    expect(await readFile(configPath, "utf8")).toBe(customized);
  });
});

describe("every-Bash approval acceptance", () => {
  test("even harmless shell commands each pass through approval", async () => {
    const temporary = await temporaryDirectory("sun-acceptance-agent-");
    cleanups.push(temporary.cleanup);
    git(temporary.path, "init", "-b", "main");
    const config = await loadConfig(temporary.path);
    const requests: ApprovalRequest[] = [];
    const decisions = [true, false];
    const events: RuntimeEvent[] = [];
    const provider = new ScriptedProvider([
      {
        kind: "tool",
        call: {
          tool: "bash",
          rationale: "Writing the first marker.",
          input: { command: "printf first > first.txt" },
        },
      },
      {
        kind: "tool",
        call: {
          tool: "bash",
          rationale: "Writing the second marker.",
          input: { command: "printf second > second.txt" },
        },
      },
      { kind: "complete", summary: "Approval behavior checked." },
    ]);
    const agent = await Agent.create({
      config,
      provider,
      approval: {
        confirm: async (request) => {
          requests.push(request);
          return decisions.shift() ?? false;
        },
      },
      sink: (event) => void events.push(event),
    });

    const result = await agent.run("Try two harmless shell commands");

    expect(result.state).toBe("complete");
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.command)).toEqual([
      "printf first > first.txt",
      "printf second > second.txt",
    ]);
    expect(
      requests.every(
        (request) => request.reason === "Sun asks before every shell command.",
      ),
    ).toBeTrue();
    expect(await Bun.file(join(temporary.path, "first.txt")).exists()).toBeTrue();
    expect(await Bun.file(join(temporary.path, "second.txt")).exists()).toBeFalse();
    expect(
      events.filter((event) => event.type === "approval"),
    ).toHaveLength(2);
    expect(
      events.some(
        (event) =>
          event.type === "tool_end" &&
          event.call.input.command === "printf second > second.txt" &&
          event.result.summary === "Command skipped",
      ),
    ).toBeTrue();
  });

  test("choice 1 approves once and the next Bash command prompts again", async () => {
    const { ui, text } = terminalHarness();
    ui.start();
    ui.beginRun("check once approval");

    const first = ui.confirm(approval("printf first"));
    ui.feedKeys("1");
    expect(await first).toBeTrue();

    const second = ui.confirm(approval("printf second"));
    expect(text()).toContain("printf second");
    expect(text()).toContain("Allow Sun to run this command?");
    ui.feedKeys("3");
    expect(await second).toBeFalse();
    ui.stop();
  });

  test("choice 2 approves all later Bash commands in the same session", async () => {
    const { ui, text } = terminalHarness();
    ui.start();
    ui.beginRun("check always approval");

    const first = ui.confirm(approval("printf first"));
    ui.feedKeys("2");
    expect(await first).toBeTrue();

    const before = text();
    expect(await ui.confirm(approval("printf a-different-command"))).toBeTrue();
    // A remembered approval never opens a card, so nothing more is written.
    expect(text()).toBe(before);
    expect(before).toContain("stop asking about bash this session");
    ui.stop();
  });

  test("choice 3 skips only the pending Bash command", async () => {
    const { ui, text } = terminalHarness();
    ui.start();
    ui.beginRun("check skip approval");

    const first = ui.confirm(approval("printf skipped"));
    ui.feedKeys("3");
    expect(await first).toBeFalse();

    const second = ui.confirm(approval("printf reconsidered"));
    expect(text()).toContain("printf reconsidered");
    ui.feedKeys("1");
    expect(await second).toBeTrue();
    ui.stop();
  });

  test("declining seeds an editable replacement into steering", async () => {
    const { ui } = terminalHarness();
    ui.start();
    ui.beginRun("check edit approval");

    const pending = ui.confirm(approval("rm -rf ./dist"));
    ui.feedKeys("3");
    expect(await pending).toBeFalse();
    ui.feedKeys("\x15");
    ui.feedKeys("Use printf instead\r");

    expect(ui.drainInput()).toEqual(["Use printf instead"]);
    ui.stop();
  });
});

describe("local Git and responsive TUI acceptance", () => {
  test("local Git commits work while remote-login credentials are unavailable", async () => {
    const temporary = await temporaryDirectory("sun-acceptance-git-");
    cleanups.push(temporary.cleanup);
    git(temporary.path, "init", "-b", "main");
    await writeFile(join(temporary.path, "README.md"), "local repository\n");
    git(temporary.path, "add", "README.md");

    const result = await runProcess(
      [
        "bash",
        "-lc",
        [
          'test -z "${GH_TOKEN:-}"',
          'test -z "${GITHUB_TOKEN:-}"',
          'test -z "${SSH_AUTH_SOCK:-}"',
          'test "${GIT_TERMINAL_PROMPT:-}" = "0"',
          "git -c user.name='Sun Acceptance' -c user.email='sun@example.invalid' commit -m local-only",
          "git log -1 --format=%s",
        ].join("\n"),
      ],
      {
        cwd: temporary.path,
        timeoutMs: 10_000,
        maxOutputBytes: 20_000,
        env: {
          GH_TOKEN: "must-not-leak",
          GITHUB_TOKEN: "must-not-leak",
          SSH_AUTH_SOCK: "/tmp/must-not-leak.sock",
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("local-only");
  });

  test("the approval and activity rows stay within narrow terminals", () => {
    for (const width of [20, 32, 48, 80]) {
      const approvalFrame = renderFooter(
        footer({
          select: {
            title: "Allow Sun to run this command?",
            subtitle: "bun test --filter acceptance-with-a-very-long-name",
            options: [
              { label: "Yes, run it" },
              { label: "Yes, and stop asking about bash this session" },
              { label: "No, and let me steer instead" },
            ],
            selected: 0,
          },
        }),
        width,
      );
      const activeFrame = renderFooter(
        footer({
          busy: true,
          activeTool: {
            name: "bash",
            target: "bun test --filter acceptance-with-a-very-long-name",
          },
        }),
        width,
      );

      for (const line of [...approvalFrame.lines, ...activeFrame.lines]) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      const approvalText = stripAnsi(approvalFrame.lines.join("\n"));
      expect(approvalText).toContain("Yes, run it");
      // A narrow terminal clips the title rather than wrapping the card open.
      expect(approvalText).toContain(
        width < 32 ? "Allow Sun to run" : "Allow Sun to run this command?",
      );
    }
  });
});

async function invokeCli(
  ...args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([CLI, ...args], {
    cwd: PROJECT_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SUN_BASE_URL: "http://127.0.0.1:1/v1",
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function terminalHarness(): {
  ui: TerminalUI;
  text: () => string;
} {
  const chunks: string[] = [];
  const ui = new TerminalUI({
    version: "0.1.0",
    mode: "work",
    model: "offline-test-model",
    repository: "/tmp/local-repository",
    output: {
      write: (chunk) => {
        chunks.push(chunk);
      },
    },
  });
  return {
    ui,
    text: () => stripAnsi(chunks.join("")).replace(/\r/g, ""),
  };
}

function approval(command: string): ApprovalRequest {
  return {
    action: "bash: run a local command",
    reason: "Sun asks before every shell command.",
    command,
  };
}

function footer(overrides: Partial<FooterView>): FooterView {
  return {
    busy: false,
    activity: "Ready",
    elapsedMs: 0,
    totalTokens: 0,
    model: "offline-test-model",
    mode: "work",
    repository: "/tmp/local-repository",
    input: "",
    cursor: 0,
    activeTool: null,
    notice: "",
    ...overrides,
  };
}
