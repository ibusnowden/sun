import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent } from "../src/agent/agent.ts";
import { loadConfig } from "../src/config.ts";
import type { AgentEvent, RuntimeEvent } from "../src/core/types.ts";
import { ScriptedProvider } from "../src/model/scripted-provider.ts";
import { git, temporaryDirectory } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Agent", () => {
  test("runs a direct read, edit, test, and answer loop", async () => {
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
    const config = await loadConfig(temporary.path);
    const provider = new ScriptedProvider([
      {
        kind: "tool",
        call: {
          tool: "read",
          rationale: "Reading the target first.",
          input: { path: "app.txt" },
        },
      },
      {
        kind: "tool",
        call: {
          tool: "edit",
          rationale: "Updating the greeting.",
          input: {
            path: "app.txt",
            oldText: "hello world",
            newText: "hello sun",
            expectedMatches: 1,
          },
        },
      },
      {
        kind: "tool",
        call: {
          tool: "bash",
          rationale: "Running the focused test.",
          input: { command: "grep -q 'hello sun' app.txt" },
        },
      },
      { kind: "complete", summary: "Updated and tested the greeting." },
    ]);
    const events: RuntimeEvent[] = [];
    const agent = await Agent.create({
      config,
      provider,
      approval: { confirm: async () => true },
      sink: (event) => void events.push(event),
    });

    const result = await agent.run("Update the greeting");

    expect(result).toMatchObject({
      state: "complete",
      summary: "Updated and tested the greeting.",
      filesChanged: ["app.txt"],
    });
    expect(await readFile(join(temporary.path, "app.txt"), "utf8")).toBe(
      "hello sun\n",
    );
    expect(events.filter((event) => event.type === "tool_start")).toHaveLength(3);
    expect(
      events.some(
        (event) =>
          event.type === "diff" &&
          event.patch.includes("+hello sun"),
      ),
    ).toBeTrue();
    expect(provider.contexts.at(-1)?.recentEvents).toHaveLength(7);
  });

  test("asks for approval before every bash command", async () => {
    const temporary = await temporaryDirectory();
    cleanups.push(temporary.cleanup);
    git(temporary.path, "init", "-b", "main");
    const config = await loadConfig(temporary.path);
    let confirmations = 0;
    const events: RuntimeEvent[] = [];
    const agent = await Agent.create({
      config,
      provider: new ScriptedProvider([
        {
          kind: "tool",
          call: {
            tool: "bash",
            rationale: "Running the focused tests.",
            input: { command: "bun test" },
          },
        },
        { kind: "complete", summary: "Skipped the test command." },
      ]),
      approval: {
        confirm: async () => {
          confirmations += 1;
          return false;
        },
      },
      sink: (event) => void events.push(event),
    });

    await agent.run("Run the tests");

    expect(confirmations).toBe(1);
    expect(events.some((event) => event.type === "approval")).toBeTrue();
    expect(
      events.some(
        (event) =>
          event.type === "tool_end" &&
          event.result.summary === "Command skipped",
      ),
    ).toBeTrue();
  });

  test("asks before fetching a URL, and a refusal reaches no network", async () => {
    const temporary = await temporaryDirectory();
    cleanups.push(temporary.cleanup);
    git(temporary.path, "init", "-b", "main");
    const config = await loadConfig(temporary.path);
    const asked: string[] = [];
    const events: RuntimeEvent[] = [];
    const agent = await Agent.create({
      config,
      provider: new ScriptedProvider([
        {
          kind: "tool",
          call: {
            tool: "fetch",
            rationale: "Checking the upstream changelog.",
            input: { url: "https://example.com/changelog" },
          },
        },
        { kind: "complete", summary: "Did not fetch." },
      ]),
      approval: {
        confirm: async (request) => {
          asked.push(request.command ?? "");
          return false;
        },
      },
      sink: (event) => void events.push(event),
    });

    await agent.run("What changed upstream?");

    // The URL is on the card, so the user approves an address rather than the
    // word "fetch".
    expect(asked).toEqual(["https://example.com/changelog"]);
    expect(
      events.some(
        (event) =>
          event.type === "tool_end" && event.result.summary === "Fetch skipped",
      ),
    ).toBeTrue();
  });

  test("keeps follow-up context for the lifetime of the TUI", async () => {
    const temporary = await temporaryDirectory();
    cleanups.push(temporary.cleanup);
    git(temporary.path, "init", "-b", "main");
    const config = await loadConfig(temporary.path);
    const history: AgentEvent[] = [];
    const firstProvider = new ScriptedProvider([
      { kind: "complete", summary: "The entry point is src/index.ts." },
    ]);
    const secondProvider = new ScriptedProvider([
      { kind: "complete", summary: "I updated that entry point." },
    ]);
    const shared = {
      config,
      approval: { confirm: async () => false },
      history,
    };

    await (await Agent.create({ ...shared, provider: firstProvider })).run(
      "Where is the entry point?",
    );
    await (await Agent.create({ ...shared, provider: secondProvider })).run(
      "Now update it.",
    );

    expect(secondProvider.contexts[0]?.recentEvents).toEqual([
      { type: "user", content: "Where is the entry point?" },
      { type: "assistant", content: "The entry point is src/index.ts." },
      { type: "user", content: "Now update it." },
    ]);
  });
});
