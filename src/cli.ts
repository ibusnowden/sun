#!/usr/bin/env bun

import { resolve } from "node:path";
import { Agent } from "./agent/agent.ts";
import {
  advanceGoal,
  clearGoal,
  continuationPrompt,
  createGoal,
  loadGoal,
  saveGoal,
  shouldContinue,
  type Goal,
} from "./agent/goal.ts";
import { executePlanPrompt, planPrompt } from "./agent/plan.ts";
import {
  emptyHistory,
  loadHistory,
  recordTask,
  recordUsage,
  saveHistory,
  summarize,
  type UsageHistory,
} from "./agent/usage.ts";
import { initializeRepository, loadConfig } from "./config.ts";
import type {
  AgentEvent,
  ModelProvider,
  ProviderObserver,
  RunMode,
  RunResult,
  SunConfig,
} from "./core/types.ts";
import { createModelProvider } from "./model/provider-factory.ts";
import {
  assertWorkspaceDirectory,
  isGitRepository,
  repositoryChanges,
} from "./repository/inspect.ts";
import { PlainUI } from "./tui/plain-ui.ts";
import {
  TerminalUI,
  type GoalController,
  type ModelController,
  type UsageController,
} from "./tui/terminal-ui.ts";
import { sanitizeTerminalText } from "./tui/theme.ts";
import { checkForUpdate, installLatest, updateNotice } from "./update.ts";
import { PACKAGE_NAME, VERSION } from "./version.ts";

const COMMANDS = new Set([
  "init",
  "doctor",
  "update",
  "inspect",
  "work",
  "execute",
]);

interface Options {
  repository: string;
  model?: string;
  provider?: "openai" | "openai-compatible";
  baseUrl?: string;
  apiKeyEnv?: string;
  plain: boolean;
  plan: boolean;
  check: boolean;
  maxToolCalls?: number;
  positionals: string[];
}

// The entry call lives at the very bottom of this file, after every
// declaration it reaches. Top-level await suspends module evaluation where it
// sits, so calling main() from up here left `class SessionState` in its
// temporal dead zone: fine under `bun run`, but a hard "Cannot access
// 'SessionState' before initialization" in a `bun build --compile` binary,
// which is the artifact users actually get.

async function main(rawArgs: string[]): Promise<void> {
  const first = rawArgs[0];
  if (first === "help" || first === "--help" || first === "-h") {
    printHelp();
    return;
  }
  if (first === "--version" || first === "-v" || first === "version") {
    console.log(VERSION);
    return;
  }

  const command = first && COMMANDS.has(first) ? first : "work";
  const args = command === first ? rawArgs.slice(1) : rawArgs;
  const options = parseOptions(args);

  if (command === "init") {
    const repository = resolve(options.positionals[0] ?? options.repository);
    await assertWorkspaceDirectory(repository);
    print(`Initialized Sun at ${await initializeRepository(repository)}`);
    return;
  }
  if (command === "doctor") {
    await doctorCommand(options);
    return;
  }
  if (command === "update") {
    await updateCommand(options);
    return;
  }

  const task = options.positionals.join(" ").trim();
  const interactive =
    !options.plain && process.stdin.isTTY && process.stdout.isTTY;
  if (!task && !interactive) throw new Error("sun requires a task");

  const workspaceMode = !(await isGitRepository(options.repository));
  if (workspaceMode) await assertWorkspaceDirectory(options.repository);
  const config = await loadConfig(options.repository, {
    workspaceMode,
    ...(options.model ? { model: options.model } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv } : {}),
    ...(options.maxToolCalls ? { maxToolCalls: options.maxToolCalls } : {}),
  });

  const mode: RunMode = options.plan ? "plan" : "work";
  if (interactive) await runSession(config, task, mode, await startupNotice());
  else await runPlain(config, task, mode);
}

async function runSession(
  config: SunConfig,
  firstTask: string,
  mode: RunMode,
  notice?: string,
): Promise<void> {
  const session = new SessionState(config);
  await session.load();

  const ui = new TerminalUI({
    version: VERSION,
    ...(notice ? { notice } : {}),
    mode,
    model: config.model,
    repository: config.repository,
    models: session.models(),
    goal: session.goals(),
    usage: session.usageController(),
    // No baseline, so this is the whole working tree rather than one turn's
    // changes — the same thing `git diff` would show, untracked files included.
    workingDiff: async () => {
      const changes = await repositoryChanges(config);
      // Saying "no changes" when Git could not read the tree at all would be a
      // lie in exactly the case the user most needs the truth.
      if (changes.unreadable) throw new Error(changes.unreadable);
      return changes.diff;
    },
  });
  ui.start();

  let pending: string | null = firstTask || null;
  /** An approved plan, queued to run without asking the user to retype it. */
  let pendingTurn: Turn | null = null;
  let lastState: RunResult["state"] | null = null;
  const history: AgentEvent[] = [];
  try {
    for (;;) {
      let turn: Turn | null;
      if (pendingTurn) {
        turn = pendingTurn;
        pendingTurn = null;
      } else {
        const typed = pending ?? (await ui.readTask());
        pending = null;
        if (typed === null || ui.exitRequested) break;
        // An empty task means "a goal is active, keep going". Anything the
        // user typed is run as itself, goal or no goal.
        turn = session.nextTurn(typed);
      }
      if (!turn) continue;

      // Read once: approving a plan flips the mode, and this turn belongs to
      // the mode it started in.
      const mode = ui.mode;
      const prompt = mode === "plan" ? planPrompt(turn.prompt) : turn.prompt;

      const before = ui.totalTokens;
      const startedAt = Date.now();
      const signal = ui.beginRun(prompt, turn.display);
      let result: RunResult | null = null;
      try {
        const agent = await Agent.create({
          config,
          mode,
          provider: await session.provider(ui.observer),
          approval: ui,
          sink: ui.handle,
          drainSteering: () => ui.drainInput(),
          signal,
          history,
        });
        result = await agent.run(prompt);
        lastState = result.state;
        ui.endRun(result);
      } catch (error) {
        ui.endRun(null);
        ui.error(explain(error));
        lastState = "blocked";
      }
      session.recordTask(Date.now() - startedAt);
      if (ui.exitRequested) break;

      // A finished plan is worth nothing until the user decides on it, so the
      // handoff happens here rather than being left for them to retype.
      if (mode === "plan" && result?.state === "complete" && !signal.aborted) {
        const answer = await ui.confirmPlan();
        if (ui.exitRequested) break;
        if (answer === "run") {
          pendingTurn = {
            prompt: executePlanPrompt(result.summary),
            display: "Carrying out the approved plan",
            goalTurn: false,
          };
        }
      }

      const settled = await session.recordTurn(turn, result, {
        tokensUsed: ui.totalTokens - before,
        interrupted: signal.aborted,
      });
      if (settled) ui.showGoal(settled);
      await session.flushUsage();
      // A goal that is still active drives the next iteration without waiting
      // for the user, which is the whole point of setting one.
      if (!pendingTurn && session.shouldContinueGoal()) pending = "";
    }
  } finally {
    ui.stop();
    await session.flushUsage();
  }
  if (lastState === "blocked") process.exitCode = 2;
}

interface Turn {
  prompt: string;
  display: string;
  /** True when this turn is a goal continuation rather than a typed task. */
  goalTurn: boolean;
}

/**
 * Everything that outlives a single turn: the goal, the model the session is
 * currently pointed at, and the provider built for it.
 */
class SessionState {
  #goal: Goal | null = null;
  #model: string;
  #provider: ModelProvider | null = null;
  #usage: UsageHistory = emptyHistory();
  #usageDirty = false;

  constructor(readonly config: SunConfig) {
    this.#model = config.model;
  }

  async load(): Promise<void> {
    this.#goal = await loadGoal(this.config.agentDirectory);
    this.#usage = await loadHistory(this.config.agentDirectory);
  }

  /**
   * Recording is synchronous so the UI never waits on a disk write; the
   * session loop flushes after each turn, and again on the way out.
   */
  usageController(): UsageController {
    return {
      record: (usage) => {
        this.#usage = recordUsage(this.#usage, usage);
        this.#usageDirty = true;
      },
      summary: () => summarize(this.#usage),
      history: () => this.#usage,
    };
  }

  /** Wall time for one finished task, which the activity grid reports. */
  recordTask(durationMs: number): void {
    this.#usage = recordTask(this.#usage, durationMs);
    this.#usageDirty = true;
  }

  async flushUsage(): Promise<void> {
    if (!this.#usageDirty) return;
    this.#usageDirty = false;
    // Losing a token count must never take a session down.
    await saveHistory(this.config.agentDirectory, this.#usage).catch(() => {});
  }

  async provider(observer: ProviderObserver): Promise<ModelProvider> {
    this.#provider ??= await createModelProvider(
      { ...this.config, model: this.#model },
      observer,
    );
    return this.#provider;
  }

  models(): ModelController {
    return {
      current: () => this.#model,
      list: async () => await listModels({ ...this.config, model: this.#model }),
      select: async (model) => {
        this.#model = model;
        // The next turn builds a fresh provider; the transcript is untouched.
        this.#provider = null;
      },
    };
  }

  goals(): GoalController {
    const persist = async (goal: Goal | null): Promise<void> => {
      this.#goal = goal;
      if (goal) await saveGoal(this.config.agentDirectory, goal);
      else await clearGoal(this.config.agentDirectory);
    };
    return {
      current: () => this.#goal,
      set: async (objective, tokenBudget) => {
        const goal = createGoal(objective, tokenBudget);
        await persist(goal);
        return goal;
      },
      clear: async () => await persist(null),
      pause: async () => {
        if (!this.#goal) return null;
        const paused: Goal = { ...this.#goal, status: "paused" };
        await persist(paused);
        return paused;
      },
      resume: async () => {
        if (!this.#goal) return null;
        const resumed: Goal = {
          ...this.#goal,
          status: "active",
          blockedStreak: 0,
        };
        await persist(resumed);
        return resumed;
      },
    };
  }

  /** Turn what the user submitted into the prompt the agent actually runs. */
  nextTurn(typed: string): Turn | null {
    const task = typed.trim();
    if (task) return { prompt: task, display: task, goalTurn: false };
    const goal = this.#goal;
    if (!shouldContinue(goal)) return null;
    return {
      prompt: continuationPrompt(goal),
      display:
        goal.turns === 0
          ? goal.objective
          : `Continuing the goal (turn ${goal.turns + 1})`,
      goalTurn: true,
    };
  }

  /**
   * Fold a finished turn into the goal. Returns the goal to show the user when
   * it has stopped being active, and null while it is still running.
   */
  async recordTurn(
    turn: Turn,
    result: RunResult | null,
    outcome: { tokensUsed: number; interrupted: boolean },
  ): Promise<Goal | null> {
    if (!turn.goalTurn || !this.#goal) return null;
    // A failed turn is not a verdict, but it still costs a turn and tokens.
    const next = advanceGoal(this.#goal, {
      verdict: result?.goal ?? null,
      tokensUsed: outcome.tokensUsed,
      interrupted: outcome.interrupted || result === null,
    });
    this.#goal = next;
    await saveGoal(this.config.agentDirectory, next);
    return next.status === "active" ? null : next;
  }

  shouldContinueGoal(): boolean {
    return shouldContinue(this.#goal);
  }
}

async function runPlain(
  config: SunConfig,
  task: string,
  mode: RunMode,
): Promise<void> {
  const ui = new PlainUI();
  const provider = await createModelProvider(config, ui.observer);
  const agent = await Agent.create({
    config,
    mode,
    provider,
    approval: ui,
    sink: ui.handle,
  });
  // Non-interactive runs have nobody to approve a plan, so a plan-mode run
  // prints the plan and stops there.
  const result = await agent.run(mode === "plan" ? planPrompt(task) : task);
  ui.summarize(result);
  if (result.state === "blocked") process.exitCode = 2;
}

function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /connection error|ECONNREFUSED|fetch failed|socket hang up|ENOTFOUND/i.test(
    message,
  )
    ? `${message}\nThe model endpoint did not answer. Check it with "sun doctor".`
    : message;
}

/**
 * The models the configured endpoint reports. Shared by `sun doctor` and the
 * `/model` picker so they can never disagree about what is reachable.
 */
async function listModels(config: SunConfig): Promise<string[]> {
  const baseUrl = (
    config.provider === "openai"
      ? "https://api.openai.com/v1"
      : (config.baseUrl ?? "")
  ).replace(/\/+$/, "");
  if (!baseUrl) throw new Error("No model base URL is configured");
  const apiKey =
    process.env[config.apiKeyEnv] ??
    (config.provider === "openai-compatible"
      ? "local"
      : process.env.OPENAI_API_KEY);
  if (!apiKey) throw new Error(`No API key found in ${config.apiKeyEnv}`);
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json()) as {
    data?: Array<{ id?: string }>;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(
      `Provider health check failed (${response.status}): ${body.error?.message ?? JSON.stringify(body)}`,
    );
  }
  return body.data?.flatMap((item) => (item.id ? [item.id] : [])) ?? [];
}

async function doctorCommand(options: Options): Promise<void> {
  const config = await loadConfig(options.repository, {
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv } : {}),
  });
  const baseUrl = (
    config.provider === "openai"
      ? "https://api.openai.com/v1"
      : (config.baseUrl ?? "")
  ).replace(/\/+$/, "");
  const models = await listModels(config);
  print(`Provider: ${config.provider}`);
  print(`Base URL: ${baseUrl}`);
  print(`Configured model: ${config.model}`);
  print(`Context window: ${config.modelContextTokens} tokens`);
  print("Reachable: yes");
  print(`Available models: ${models.join(", ") || "(none reported)"}`);
  if (!models.includes(config.model)) {
    throw new Error(`Configured model "${config.model}" was not reported`);
  }
}

/**
 * `sun update` reports honestly and only then acts. `--check` stops after the
 * report, which is what a script or a curious user wants; the bare form
 * installs, but still says nothing is needed when nothing is.
 */
async function updateCommand(options: Options): Promise<void> {
  // An explicit update ignores the daily cache: the user asking is a stronger
  // signal than "we looked this morning".
  const update = await checkForUpdate({ force: true });
  if (!update) {
    print(
      `Sun ${VERSION}. Could not reach the registry to check for updates — ${PACKAGE_NAME} may not be published yet.`,
    );
    return;
  }
  if (!update.outdated) {
    print(`Sun ${update.current} is the latest version.`);
    return;
  }

  print(`Update available: ${update.current} → ${update.latest}`);
  if (options.check) return;

  print("Installing…");
  const result = await installLatest();
  if (!result.ok) throw new Error(result.message);
  print(`Updated to ${update.latest}. Restart sun to pick it up.`);
}

/**
 * The startup check, for interactive sessions only. Scripted runs (`--plain`)
 * are left alone: a pipeline should not pay a network timeout, and its output
 * belongs to the caller rather than to a banner.
 */
async function startupNotice(): Promise<string | undefined> {
  return updateNotice(await checkForUpdate()) ?? undefined;
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    repository: process.cwd(),
    plain: false,
    plan: false,
    check: false,
    positionals: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (value === "--plain") {
      options.plain = true;
    } else if (value === "--plan") {
      options.plan = true;
    } else if (value === "--check") {
      options.check = true;
    } else if (value === "--repo") {
      options.repository = resolve(requiredValue(args, ++index, value));
    } else if (value.startsWith("--repo=")) {
      options.repository = resolve(value.slice(7));
    } else if (value === "--model") {
      options.model = requiredValue(args, ++index, value);
    } else if (value.startsWith("--model=")) {
      options.model = value.slice(8);
    } else if (value === "--provider") {
      const provider = requiredValue(args, ++index, value);
      if (provider !== "openai" && provider !== "openai-compatible") {
        throw new Error('--provider must be "openai" or "openai-compatible"');
      }
      options.provider = provider;
    } else if (value === "--base-url") {
      options.baseUrl = requiredValue(args, ++index, value);
    } else if (value === "--api-key-env") {
      options.apiKeyEnv = requiredValue(args, ++index, value);
    } else if (value === "--max-tool-calls") {
      options.maxToolCalls = positiveInteger(
        requiredValue(args, ++index, value),
        value,
      );
    } else if (value.startsWith("-")) {
      throw new Error(`Unknown option: ${value}`);
    } else {
      options.positionals.push(value);
    }
  }
  return options;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Sun ${VERSION} — a simple coding agent

Usage:
  sun                         Open the interactive agent
  sun "task"                  Open Sun and run a task
  sun --plain "task"          Run one task without the TUI
  sun --plan "task"           Start in plan mode: propose, change nothing
  sun init [directory]        Create .agent/config.toml
  sun doctor                  Check the configured model
  sun update [--check]        Install the latest release, or just report it

Options:
  --repo <path>               Workspace (default: current directory)
  --model <id>                Override the configured model
  --provider <kind>           openai or openai-compatible
  --base-url <url>            OpenAI-compatible API base URL
  --api-key-env <name>        API-key environment variable
  --max-tool-calls <n>        Maximum tools in one turn

Tools:
  read  edit  write  bash  publish

In a session:
  /goal <objective>           Work toward an objective across turns
  /plan                       Investigate and propose without changing anything
  /model                      Switch the model for the next turn
  /approvals                  Ask before each command, or run straight through
  /usage [session|daily|…]    Token activity: this session, or a year as a grid
  /diff  /files  /help        Inspect the run
  esc                         Interrupt, keeping the partial transcript

The legacy inspect, work, and execute command names remain aliases for sun.`);
}

function print(message: string): void {
  console.log(sanitizeTerminalText(message));
}

await main(Bun.argv.slice(2)).catch((error) => {
  console.error(
    sanitizeTerminalText(
      error instanceof Error ? error.message : String(error),
    ),
  );
  process.exitCode = 1;
});
