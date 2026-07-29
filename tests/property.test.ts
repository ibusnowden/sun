import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  readFile,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { Agent } from "../src/agent/agent.ts";
import { loadConfig } from "../src/config.ts";
import {
  childEnvironment,
  runProcess,
} from "../src/core/process.ts";
import type {
  AgentContext,
  AgentDecision,
  ModelProvider,
  RuntimeEvent,
  SunConfig,
  ToolCall,
} from "../src/core/types.ts";
import {
  captureRepositoryBaseline,
  listWorkspaceFiles,
  observeRepository,
  repositoryChanges,
} from "../src/repository/inspect.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { git, temporaryDirectory } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
const originalEnvironment = { ...process.env };

afterEach(async () => {
  for (const name of [
    "SUN_PROVIDER",
    "SUN_MODEL",
    "SUN_BASE_URL",
    "SUN_API_KEY_ENV",
  ]) {
    if (originalEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnvironment[name];
  }
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Agent invariants", () => {
  test("executes exactly the configured maximum number of tools", async () => {
    const { path, cleanup } = await temporaryDirectory();
    cleanups.push(cleanup);
    git(path, "init", "-b", "main");
    const config = await loadConfig(path, { maxToolCalls: 7 });
    const provider = new RepeatingProvider({
      kind: "tool",
      call: call("read", { path: "missing.txt" }),
    });
    const events: RuntimeEvent[] = [];
    const agent = await Agent.create({
      config,
      provider,
      approval: { confirm: async () => {
        throw new Error("read must not request approval");
      } },
      sink: (event) => void events.push(event),
    });

    const result = await agent.run("Keep inspecting");

    expect(provider.contexts).toHaveLength(7);
    expect(provider.contexts.map((context) => context.toolCalls)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
    expect(events.filter((event) => event.type === "tool_start")).toHaveLength(7);
    expect(result).toMatchObject({
      state: "blocked",
      summary: "Stopped after 7 tool calls",
    });
  });

  test("bounds provider history and appends steering in FIFO order", async () => {
    const { path, cleanup } = await temporaryDirectory();
    cleanups.push(cleanup);
    git(path, "init", "-b", "main");
    const config = await loadConfig(path);
    const history = Array.from({ length: 50 }, (_, index) => ({
      type: "assistant" as const,
      content: `old-${index}`,
    }));
    const provider = new RepeatingProvider({
      kind: "complete",
      summary: "done",
    });
    const agent = await Agent.create({
      config,
      provider,
      history,
      drainSteering: () => ["first", "second"],
      approval: { confirm: async () => false },
    });

    await agent.run("new task");

    const recent = provider.contexts[0]?.recentEvents ?? [];
    expect(recent).toHaveLength(40);
    expect(recent.slice(-3)).toEqual([
      { type: "user", content: "new task" },
      { type: "steering", content: "first" },
      { type: "steering", content: "second" },
    ]);
    expect(recent[0]).toEqual({ type: "assistant", content: "old-13" });
    expect(history.at(-1)).toEqual({ type: "assistant", content: "done" });
  });
});

describe("ToolRegistry invariants", () => {
  test("invalid edit inputs never mutate the target", async () => {
    const { root, registry } = await setupRegistry();
    const target = join(root, "target.txt");
    const initial = "alpha beta alpha\n";
    await writeFile(target, initial);
    const invalidInputs: Record<string, unknown>[] = [
      { path: "target.txt", oldText: "", newText: "x" },
      {
        path: "target.txt",
        oldText: "alpha",
        newText: "x",
        expectedMatches: 0,
      },
      {
        path: "target.txt",
        oldText: "alpha",
        newText: "x",
        expectedMatches: -1,
      },
      {
        path: "target.txt",
        oldText: "alpha",
        newText: "x",
        expectedMatches: 1.5,
      },
      {
        path: "target.txt",
        oldText: "alpha",
        newText: "x",
        expectedMatches: 3,
      },
    ];

    for (const input of invalidInputs) {
      const result = await registry.execute(call("edit", input));
      expect(result.ok).toBeFalse();
      expect(await readFile(target, "utf8")).toBe(initial);
    }
  });

  test("exact edits replace every and only expected match", async () => {
    for (let matches = 1; matches <= 12; matches += 1) {
      const { root, registry } = await setupRegistry();
      const target = join(root, `matches-${matches}.txt`);
      const content = Array.from({ length: matches }, () => "needle")
        .join("|");
      await writeFile(target, content);

      const result = await registry.execute(
        call("edit", {
          path: `matches-${matches}.txt`,
          oldText: "needle",
          newText: "replacement",
          expectedMatches: matches,
        }),
      );

      expect(result.ok).toBeTrue();
      expect(result.metadata).toEqual({
        path: `matches-${matches}.txt`,
        matches,
        startLine: 1,
      });
      expect(await readFile(target, "utf8")).toBe(
        Array.from({ length: matches }, () => "replacement").join("|"),
      );
    }
  });

  test("line ranges are inclusive and preserve original line numbers", async () => {
    const { root, registry } = await setupRegistry();
    const lines = Array.from({ length: 25 }, (_, index) => `line-${index + 1}`);
    await writeFile(join(root, "lines.txt"), lines.join("\n"));

    for (let start = 1; start <= lines.length; start += 4) {
      const end = Math.min(lines.length, start + 2);
      const result = await registry.execute(
        call("read", { path: "lines.txt", startLine: start, endLine: end }),
      );
      const outputLines = result.output.split("\n");

      expect(result.ok).toBeTrue();
      expect(outputLines).toHaveLength(end - start + 1);
      expect(outputLines[0]).toEndWith(` | line-${start}`);
      expect(outputLines.at(-1)).toEndWith(` | line-${end}`);
    }
  });

  test("write defaults to no-overwrite and reports UTF-8 byte size", async () => {
    const { root, registry } = await setupRegistry();
    const content = "snowman ☃ and sun ☀";
    const created = await registry.execute(
      call("write", { path: "unicode.txt", content }),
    );
    const refused = await registry.execute(
      call("write", { path: "unicode.txt", content: "changed" }),
    );

    expect(created).toMatchObject({
      ok: true,
      metadata: {
        path: "unicode.txt",
        bytes: Buffer.byteLength(content),
      },
    });
    expect(refused.ok).toBeFalse();
    expect(await readFile(join(root, "unicode.txt"), "utf8")).toBe(content);
  });
});

describe("process environment invariants", () => {
  test("credential additions cannot override the denylist", () => {
    const credentials = {
      GITHUB_TOKEN: "github",
      GH_TOKEN: "gh",
      GITLAB_TOKEN: "gitlab",
      GLAB_TOKEN: "glab",
      BITBUCKET_TOKEN: "bitbucket",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    };
    const environment = childEnvironment({
      ...credentials,
      SAFE_VALUE: "preserved",
      GIT_TERMINAL_PROMPT: "1",
      GCM_INTERACTIVE: "Always",
      GIT_ASKPASS: "/tmp/steal",
      SSH_ASKPASS: "/tmp/steal",
    });

    for (const name of Object.keys(credentials)) {
      expect(environment[name]).toBeUndefined();
    }
    expect(environment.SAFE_VALUE).toBe("preserved");
    expect(environment).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_ASKPASS: "/bin/false",
      SSH_ASKPASS: "/bin/false",
    });
  });

  test("extends valid Git config arrays and normalizes invalid counts", () => {
    for (const count of ["0", "1", "8"]) {
      const environment = childEnvironment({ GIT_CONFIG_COUNT: count });
      expect(environment.GIT_CONFIG_COUNT).toBe(String(Number(count) + 1));
      expect(environment[`GIT_CONFIG_KEY_${count}`]).toBe("credential.helper");
      expect(environment[`GIT_CONFIG_VALUE_${count}`]).toBe("");
    }
    for (const count of ["-1", "1.5", "NaN", ""]) {
      const environment = childEnvironment({ GIT_CONFIG_COUNT: count });
      expect(environment.GIT_CONFIG_COUNT).toBe("1");
      expect(environment.GIT_CONFIG_KEY_0).toBe("credential.helper");
      expect(environment.GIT_CONFIG_VALUE_0).toBe("");
    }
  });

  test("truncation is deterministic across stdout and stderr", async () => {
    const { path, cleanup } = await temporaryDirectory();
    cleanups.push(cleanup);
    const result = await runProcess(
      [
        "bash",
        "-lc",
        "printf 'abcdefghijklmnop'; printf 'QRSTUVWXYZabcdef' >&2",
      ],
      { cwd: path, timeoutMs: 5_000, maxOutputBytes: 12 },
    );

    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      truncated: true,
      stdout: "abcdef\n[TRUNCATED]",
      stderr: "QRSTUV\n[TRUNCATED]",
    });
  });
});

describe("configuration invariants", () => {
  test("initialization is idempotent and never overwrites user config", async () => {
    const { path, cleanup } = await temporaryDirectory();
    cleanups.push(cleanup);
    const first = await loadConfig(path);
    const configPath = join(path, ".agent", "config.toml");
    await writeFile(
      configPath,
      [
        'provider = "openai"',
        'model = "custom-model"',
        'base_url = "https://example.invalid/v1"',
        'api_key_env = "CUSTOM_KEY"',
        "max_tool_calls = 3",
        "stream_reasoning = false",
      ].join("\n"),
    );

    const second = await loadConfig(path);

    expect(first.repository).toBe(resolve(path));
    expect(second).toMatchObject({
      repository: resolve(path),
      agentDirectory: join(resolve(path), ".agent"),
      provider: "openai",
      model: "custom-model",
      baseUrl: "https://example.invalid/v1",
      apiKeyEnv: "CUSTOM_KEY",
      maxToolCalls: 3,
      streamReasoning: false,
    });
    expect(await readFile(configPath, "utf8")).toContain("custom-model");
  });

  test("applies precedence overrides, environment, TOML, defaults", async () => {
    const { path, cleanup } = await temporaryDirectory();
    cleanups.push(cleanup);
    await mkdir(join(path, ".agent"), { recursive: true });
    await writeFile(
      join(path, ".agent", "config.toml"),
      [
        'provider = "openai-compatible"',
        'model = "toml-model"',
        'base_url = "https://toml.invalid/v1"',
        'api_key_env = "TOML_KEY"',
      ].join("\n"),
    );
    process.env.SUN_PROVIDER = "openai";
    process.env.SUN_MODEL = "environment-model";
    process.env.SUN_BASE_URL = "https://environment.invalid/v1";
    process.env.SUN_API_KEY_ENV = "ENVIRONMENT_KEY";

    const environment = await loadConfig(path);
    const overrides = await loadConfig(path, {
      provider: "openai-compatible",
      model: "override-model",
      baseUrl: "https://override.invalid/v1",
      apiKeyEnv: "OVERRIDE_KEY",
      workspaceMode: true,
    });

    expect(environment).toMatchObject({
      provider: "openai",
      model: "environment-model",
      baseUrl: "https://environment.invalid/v1",
      apiKeyEnv: "ENVIRONMENT_KEY",
    });
    expect(overrides).toMatchObject({
      provider: "openai-compatible",
      model: "override-model",
      baseUrl: "https://override.invalid/v1",
      apiKeyEnv: "OVERRIDE_KEY",
      workspaceMode: true,
    });
  });

  test("rejects every unknown provider supplied through the environment", async () => {
    for (const invalid of ["OpenAI", "openai ", "", "other"]) {
      const { path, cleanup } = await temporaryDirectory();
      cleanups.push(cleanup);
      process.env.SUN_PROVIDER = invalid;
      await expect(loadConfig(path)).rejects.toThrow("SUN_PROVIDER must be");
    }
  });
});

describe("repository helper invariants", () => {
  test("workspace enumeration is sorted, pruned, and bounded", async () => {
    const { path, cleanup } = await temporaryDirectory();
    cleanups.push(cleanup);
    for (const relative of [
      "z-last.txt",
      "alpha/deep/c.txt",
      "alpha/a.txt",
      "beta/b.txt",
      "beta/node_modules/ignored.js",
      ".agent/ignored.toml",
      "target/ignored.bin",
    ]) {
      const target = join(path, relative);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, relative);
    }

    const all = await listWorkspaceFiles(path);
    const limited = await listWorkspaceFiles(path, 3);

    expect(all).toEqual([
      "alpha/a.txt",
      "alpha/deep/c.txt",
      "beta/b.txt",
      "z-last.txt",
    ]);
    expect(limited).toHaveLength(3);
    expect(limited).toEqual([...limited].sort());
    expect(limited.every((file) => all.includes(file))).toBeTrue();
  });

  test("Git changes are relative to the baseline and exclude .agent", async () => {
    const { path, cleanup } = await temporaryDirectory();
    cleanups.push(cleanup);
    git(path, "init", "-b", "main");
    await writeFile(join(path, "tracked.txt"), "before\n");
    git(path, "add", "tracked.txt");
    git(
      path,
      "-c",
      "user.name=Sun Test",
      "-c",
      "user.email=sun@example.invalid",
      "commit",
      "-m",
      "baseline",
    );
    const config = await loadConfig(path);
    const baseline = await captureRepositoryBaseline(config);
    await Promise.all([
      writeFile(join(path, "tracked.txt"), "after\n"),
      writeFile(join(path, "created.txt"), "new\n"),
      writeFile(join(path, ".agent", "ignored.txt"), "ignored\n"),
    ]);

    const changes = await repositoryChanges(config, baseline);
    const observation = await observeRepository(config);

    expect(changes.files).toEqual(["created.txt", "tracked.txt"]);
    expect(changes.diff).toContain("+after");
    expect(changes.diff).toContain("+new");
    expect(changes.diff).not.toContain("ignored.txt");
    expect(observation.files).toContain("created.txt");
    expect(observation.files).not.toContain(".agent/ignored.txt");
  });

  test("workspace baselines detect create, modify, and delete", async () => {
    const { path, cleanup } = await temporaryDirectory();
    cleanups.push(cleanup);
    await writeFile(join(path, "modify.txt"), "before");
    await writeFile(join(path, "delete.txt"), "delete me");
    const config = testConfig(path, true);
    const baseline = await captureRepositoryBaseline(config);
    const original = await stat(join(path, "modify.txt"));
    await writeFile(join(path, "modify.txt"), "after!");
    await utimes(
      join(path, "modify.txt"),
      original.atime,
      new Date(original.mtimeMs + 2_000),
    );
    await Bun.file(join(path, "delete.txt")).delete();
    await writeFile(join(path, "create.txt"), "created");

    const changes = await repositoryChanges(config, baseline);

    expect(changes.files).toEqual([
      "create.txt",
      "delete.txt",
      "modify.txt",
    ]);
    expect(changes.diff.split("\n")).toEqual([
      "Workspace changes (the workspace root is not a Git repository):",
      "M create.txt",
      "D delete.txt",
      "M modify.txt",
    ]);
  });
});

class RepeatingProvider implements ModelProvider {
  readonly contexts: AgentContext[] = [];

  constructor(readonly decision: AgentDecision) {}

  async next(context: AgentContext): Promise<AgentDecision> {
    this.contexts.push(context);
    return this.decision;
  }
}

async function setupRegistry(): Promise<{
  root: string;
  registry: ToolRegistry;
}> {
  const { path, cleanup } = await temporaryDirectory();
  cleanups.push(cleanup);
  git(path, "init", "-b", "main");
  return {
    root: path,
    registry: await ToolRegistry.create(testConfig(path)),
  };
}

function testConfig(repository: string, workspaceMode = false): SunConfig {
  return {
    repository,
    workspaceMode,
    agentDirectory: join(repository, ".agent"),
    provider: "openai-compatible",
    model: "test",
    baseUrl: "http://127.0.0.1:4000/v1",
    apiKeyEnv: "SUN_API_KEY",
    modelTimeoutMs: 5_000,
    modelMaxTokens: 1_000,
    modelContextTokens: 32_000,
    maxToolCalls: 10,
    commandTimeoutMs: 5_000,
    maxOutputBytes: 20_000,
    streamReasoning: false,
  };
}

function call(tool: ToolCall["tool"], input: Record<string, unknown>): ToolCall {
  return { tool, rationale: "property test", input };
}
