import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SunConfig, ToolCall } from "../src/core/types.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { git, temporaryDirectory } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function setup(
  workspaceMode = false,
): Promise<{ root: string; registry: ToolRegistry }> {
  const temporary = await temporaryDirectory();
  cleanups.push(temporary.cleanup);
  if (!workspaceMode) git(temporary.path, "init", "-b", "main");
  await mkdir(join(temporary.path, ".agent"), { recursive: true });
  const config: SunConfig = {
    repository: temporary.path,
    workspaceMode,
    agentDirectory: join(temporary.path, ".agent"),
    provider: "openai-compatible",
    model: "test",
    baseUrl: "http://127.0.0.1:4000/v1",
    apiKeyEnv: "SUN_API_KEY",
    modelTimeoutMs: 5_000,
    modelMaxTokens: 1_000,
    modelContextTokens: 262_144,
    maxToolCalls: 10,
    commandTimeoutMs: 5_000,
    maxOutputBytes: 20_000,
    streamReasoning: false,
  };
  return {
    root: temporary.path,
    registry: await ToolRegistry.create(config),
  };
}

describe("ToolRegistry", () => {
  test("reads, exact-edits, writes, and runs bash", async () => {
    const { root, registry } = await setup();
    await writeFile(join(root, "app.txt"), "hello world\n");

    const read = await registry.execute(call("read", { path: "app.txt" }));
    expect(read.ok).toBeTrue();
    expect(read.output).toContain("hello world");

    const edit = await registry.execute(
      call("edit", {
        path: "app.txt",
        oldText: "hello world",
        newText: "hello sun",
        expectedMatches: 1,
      }),
    );
    expect(edit.ok).toBeTrue();

    const write = await registry.execute(
      call("write", {
        path: "new.txt",
        content: "created by sun\n",
        overwrite: false,
      }),
    );
    expect(write.ok).toBeTrue();

    const verify = await registry.execute(
      call("bash", {
        command: "grep -q 'hello sun' app.txt",
      }),
    );
    expect(verify.ok).toBeTrue();
  });

  test("refuses ambiguous exact edits", async () => {
    const { root, registry } = await setup();
    await writeFile(join(root, "app.txt"), "same\nsame\n");
    const result = await registry.execute(
      call("edit", {
        path: "app.txt",
        oldText: "same",
        newText: "different",
        expectedMatches: 1,
      }),
    );
    expect(result.ok).toBeFalse();
    expect(result.summary).toContain("found 2");
  });

  test("rejects traversal and symlink escapes", async () => {
    const { root, registry } = await setup();
    const outside = await temporaryDirectory("sun-outside-");
    cleanups.push(outside.cleanup);
    await writeFile(join(outside.path, "secret.txt"), "secret");
    await symlink(outside.path, join(root, "escape"));

    const traversal = await registry.execute(
      call("read", { path: "../secret.txt" }),
    );
    expect(traversal.ok).toBeFalse();
    expect(traversal.summary).toContain("escapes repository");

    const symlinkResult = await registry.execute(
      call("read", { path: "escape/secret.txt" }),
    );
    expect(symlinkResult.ok).toBeFalse();
    expect(symlinkResult.summary).toContain("escapes repository");
  });

  test("rejects writes through a dangling symlink", async () => {
    const { root, registry } = await setup();
    const outside = await temporaryDirectory("sun-outside-");
    cleanups.push(outside.cleanup);
    const outsideTarget = join(outside.path, "not-created.txt");
    await symlink(outsideTarget, join(root, "dangling"));

    const result = await registry.execute(
      call("write", {
        path: "dangling",
        content: "must remain confined",
        overwrite: true,
      }),
    );
    expect(result.ok).toBeFalse();
    expect(result.summary).toContain("dangling symlink");
    expect(await Bun.file(outsideTarget).exists()).toBeFalse();
  });
});

describe("per-tool token accounting", () => {
  test("stamps every result and attributes cost to the tool that produced it", async () => {
    const { root, registry } = await setup();
    await writeFile(join(root, "big.txt"), "x".repeat(3_000));

    const read = await registry.execute(call("read", { path: "big.txt" }));
    expect(read.ok).toBeTrue();
    // The estimator is characters over a fixed divisor, so a 3,000-character
    // file must land in the same order of magnitude, not at zero.
    expect(read.outputTokens).toBeGreaterThan(500);

    const quiet = await registry.execute(
      call("bash", { command: "printf hi" }),
    );
    expect(quiet.outputTokens).toBeLessThan(read.outputTokens ?? 0);

    const usage = registry.usage();
    // Heaviest first, so the tool eating the context window leads.
    expect(usage[0]?.tool).toBe("read");
    expect(usage.map((entry) => entry.tool).sort()).toEqual(["bash", "read"]);
    const readUsage = usage.find((entry) => entry.tool === "read");
    expect(readUsage).toMatchObject({ calls: 1, failures: 0, truncated: 0 });
    expect(readUsage?.outputTokens).toBe(read.outputTokens ?? 0);
  });

  test("counts failures and repeated calls against the same tool", async () => {
    const { registry } = await setup();
    await registry.execute(call("bash", { command: "true" }));
    await registry.execute(call("bash", { command: "exit 3" }));
    await registry.execute(call("read", { path: "does-not-exist.txt" }));

    const bash = registry.usage().find((entry) => entry.tool === "bash");
    expect(bash).toMatchObject({ tool: "bash", calls: 2, failures: 1 });
    const read = registry.usage().find((entry) => entry.tool === "read");
    expect(read).toMatchObject({ tool: "read", calls: 1, failures: 1 });
  });

  test("records output that came back clipped", async () => {
    const { registry } = await setup();
    // maxOutputBytes is 20_000 in the test config.
    const result = await registry.execute(
      call("bash", { command: "head -c 60000 /dev/zero | tr '\\0' 'a'" }),
    );
    expect(result.truncated).toBeTrue();
    expect(registry.usage()[0]).toMatchObject({ tool: "bash", truncated: 1 });
  });
});

function call(tool: ToolCall["tool"], input: Record<string, unknown>): ToolCall {
  return { tool, input, rationale: "test" };
}
