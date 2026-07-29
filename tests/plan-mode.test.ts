import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent } from "../src/agent/agent.ts";
import { loadConfig } from "../src/config.ts";
import type {
  AgentDecision,
  ApprovalRequest,
  RuntimeEvent,
  ToolCall,
} from "../src/core/types.ts";
import { ScriptedProvider } from "../src/model/scripted-provider.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { renderStatus } from "../src/tui/chrome.ts";
import { git, temporaryDirectory } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function repository(): Promise<string> {
  const temporary = await temporaryDirectory();
  cleanups.push(temporary.cleanup);
  git(temporary.path, "init", "-b", "main");
  await writeFile(join(temporary.path, "app.txt"), "hello world\n");
  git(temporary.path, "add", "app.txt");
  git(
    temporary.path,
    "-c",
    "user.name=Sun Test",
    "-c",
    "user.email=sun@example.invalid",
    "commit",
    "-m",
    "initial",
  );
  return temporary.path;
}

const editToolCall: ToolCall = {
  tool: "edit",
  rationale: "Updating the greeting.",
  input: {
    path: "app.txt",
    oldText: "hello world",
    newText: "hello sun",
    expectedMatches: 1,
  },
};

const editCall: AgentDecision = { kind: "tool", call: editToolCall };

describe("plan mode", () => {
  test("refuses the mutating tools at the registry, not just in the prompt", async () => {
    const root = await repository();
    const config = await loadConfig(root);
    const registry = await ToolRegistry.create(config, "plan");

    for (const tool of ["edit", "write", "publish"] as const) {
      expect(registry.blockedByMode(tool)).toBe(true);
    }
    for (const tool of ["read", "bash"] as const) {
      expect(registry.blockedByMode(tool)).toBe(false);
    }

    const result = await registry.execute(editToolCall);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("plan mode");
    expect(await readFile(join(root, "app.txt"), "utf8")).toBe("hello world\n");
  });

  test("leaves the workspace untouched and never asks to approve a refused edit", async () => {
    const root = await repository();
    const config = await loadConfig(root);
    let confirmations = 0;
    const events: RuntimeEvent[] = [];
    const agent = await Agent.create({
      config,
      mode: "plan",
      provider: new ScriptedProvider([
        editCall,
        { kind: "complete", summary: "Here is the plan.", goal: null },
      ]),
      approval: {
        confirm: async () => {
          confirmations += 1;
          return true;
        },
      },
      sink: (event) => void events.push(event),
    });

    const result = await agent.run("Change the greeting");

    expect(result.state).toBe("complete");
    expect(confirmations).toBe(0);
    expect(result.filesChanged).toEqual([]);
    expect(await readFile(join(root, "app.txt"), "utf8")).toBe("hello world\n");
    const failed = events.find(
      (event) => event.type === "tool_end" && !event.result.ok,
    );
    expect(failed).toBeDefined();
  });

  test("still allows reading and Bash, so a plan can be grounded in the code", async () => {
    const root = await repository();
    const config = await loadConfig(root);
    const agent = await Agent.create({
      config,
      mode: "plan",
      provider: new ScriptedProvider([
        {
          kind: "tool",
          call: {
            tool: "read",
            rationale: "Reading the file first.",
            input: { path: "app.txt" },
          },
        },
        { kind: "complete", summary: "Plan ready.", goal: null },
      ]),
      approval: { confirm: async () => true },
    });

    const result = await agent.run("Plan a change");
    expect(result.state).toBe("complete");
  });

  test("work mode is unaffected", async () => {
    const root = await repository();
    const config = await loadConfig(root);
    const agent = await Agent.create({
      config,
      provider: new ScriptedProvider([
        editCall,
        { kind: "complete", summary: "Done.", goal: null },
      ]),
      approval: { confirm: async () => true },
    });

    await agent.run("Change the greeting");
    expect(await readFile(join(root, "app.txt"), "utf8")).toBe("hello sun\n");
  });

  test("the footer states plan mode outright", () => {
    const planning = renderStatus(
      { model: "glm-5.2", repository: "/w", totalTokens: 0, mode: "plan" },
      80,
    ).join("");
    const working = renderStatus(
      { model: "glm-5.2", repository: "/w", totalTokens: 0, mode: "work" },
      80,
    ).join("");
    expect(planning).toContain("PLAN");
    expect(working).not.toContain("PLAN");
  });
});

describe("publish approval", () => {
  test("asks before publishing, and declining pushes nothing", async () => {
    const root = await repository();
    git(root, "remote", "add", "origin", join(root, "..", "missing.git"));
    const config = await loadConfig(root);
    const requests: ApprovalRequest[] = [];
    const agent = await Agent.create({
      config,
      provider: new ScriptedProvider([
        {
          kind: "tool",
          call: {
            tool: "publish",
            rationale: "Publishing the branch.",
            input: { remote: null, branch: null, setUpstream: null },
          },
        },
        { kind: "complete", summary: "Stopped at the gate.", goal: null },
      ]),
      approval: {
        confirm: async (request) => {
          requests.push(request);
          return false;
        },
      },
    });

    await agent.run("Push my work");

    expect(requests).toHaveLength(1);
    const [request] = requests;
    // Auto-approval must not be able to stand in for the user here.
    expect(request?.alwaysAsk).toBe(true);
    expect(request?.action).toContain("origin/main");
    expect(request?.command).toMatch(/^git push origin [0-9a-f]{12}:refs\/heads\/main$/);
    expect(request?.detail?.join("\n")).toContain("commit(s) would be published");
  });

  test("a planning error is reported without ever asking for approval", async () => {
    const root = await repository();
    const config = await loadConfig(root);
    let asked = 0;
    const agent = await Agent.create({
      config,
      provider: new ScriptedProvider([
        {
          kind: "tool",
          call: {
            tool: "publish",
            rationale: "Publishing the branch.",
            input: { remote: "nope", branch: null, setUpstream: null },
          },
        },
        { kind: "complete", summary: "Could not publish.", goal: null },
      ]),
      approval: {
        confirm: async () => {
          asked += 1;
          return true;
        },
      },
    });

    await agent.run("Push my work");
    expect(asked).toBe(0);
  });
});
