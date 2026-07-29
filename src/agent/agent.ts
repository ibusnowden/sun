import type {
  AgentEvent,
  ApprovalHandler,
  EventSink,
  ModelProvider,
  RunMode,
  RunResult,
  SunConfig,
  ToolCall,
  ToolResult,
} from "../core/types.ts";
import type { GoalVerdict } from "./goal.ts";
import {
  captureRepositoryBaseline,
  observeRepository,
  repositoryChanges,
  type RepositoryBaseline,
} from "../repository/inspect.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { describePlan, type PublishPlan } from "../tools/publish.ts";
import { planRefusal } from "./plan.ts";

/** Sun's complete agent loop: decide, run one tool, feed the result back. */
export class Agent {
  readonly #events: AgentEvent[];
  readonly #tools: ToolRegistry;
  #toolCalls = 0;

  private constructor(
    readonly config: SunConfig,
    readonly mode: RunMode,
    readonly provider: ModelProvider,
    readonly approval: ApprovalHandler,
    readonly sink: EventSink,
    readonly drainSteering: (() => string[]) | null,
    readonly signal: AbortSignal | null,
    tools: ToolRegistry,
    history: AgentEvent[],
  ) {
    this.#tools = tools;
    this.#events = history;
    provider.setAbortSignal?.(signal);
  }

  static async create(options: {
    config: SunConfig;
    mode?: RunMode;
    provider: ModelProvider;
    approval: ApprovalHandler;
    sink?: EventSink;
    drainSteering?: () => string[];
    signal?: AbortSignal;
    history?: AgentEvent[];
  }): Promise<Agent> {
    const mode = options.mode ?? "work";
    return new Agent(
      options.config,
      mode,
      options.provider,
      options.approval,
      options.sink ?? (() => {}),
      options.drainSteering ?? null,
      options.signal ?? null,
      await ToolRegistry.create(options.config, mode),
      options.history ?? [],
    );
  }

  async run(task: string): Promise<RunResult> {
    this.#events.push({ type: "user", content: task });
    const baseline = await captureRepositoryBaseline(this.config);
    const observation = await observeRepository(this.config);
    try {
      while (this.#toolCalls < this.config.maxToolCalls) {
        if (this.signal?.aborted) {
          return await this.#finish("blocked", "Interrupted by the user", baseline);
        }
        this.#acceptSteering();
        const decision = await this.provider.next({
          task,
          observation,
          recentEvents: this.#events.slice(-40),
          toolCalls: this.#toolCalls,
        });
        if (this.signal?.aborted) {
          return await this.#finish("blocked", "Interrupted by the user", baseline);
        }
        if (decision.kind === "complete") {
          return await this.#finish(
            "complete",
            decision.summary,
            baseline,
            decision.goal ?? null,
          );
        }
        if (decision.kind === "blocked") {
          return await this.#finish("blocked", decision.reason, baseline);
        }
        await this.#runTool(decision.call, baseline);
      }
      return await this.#finish(
        "blocked",
        `Stopped after ${this.config.maxToolCalls} tool calls`,
        baseline,
      );
    } catch (error) {
      if (this.signal?.aborted) {
        return await this.#finish("blocked", "Interrupted by the user", baseline);
      }
      const message = error instanceof Error ? error.message : String(error);
      return await this.#finish("blocked", message, baseline);
    }
  }

  async #runTool(
    call: ToolCall,
    baseline: RepositoryBaseline,
  ): Promise<void> {
    this.#toolCalls += 1;
    await this.sink({ type: "tool_start", call });
    this.#events.push({ type: "tool_call", content: call });

    let result: ToolResult;
    if (this.#tools.blockedByMode(call.tool)) {
      // Refused before the user is asked: an approval prompt for something
      // plan mode will not run either way is just noise.
      result = { ok: false, summary: planRefusal(call.tool), output: "" };
    } else if (call.tool === "publish") {
      result = await this.#publish(call);
    } else if (call.tool === "bash") {
      await this.sink({
        type: "approval",
        action: `bash: ${call.rationale}`,
        reason: "Sun asks before every shell command.",
      });
      const approved = await this.approval.confirm({
        action: `bash: ${call.rationale}`,
        reason: "Sun asks before every shell command.",
        command: String(call.input.command ?? ""),
      });
      result = approved
        ? await this.#tools.execute(call)
        : {
            ok: false,
            summary: "Command skipped",
            output: "",
          };
    } else if (call.tool === "fetch") {
      // Bash cannot reach the network, so a fetch is the one thing a turn does
      // that leaves this machine. The user sees the URL before it is requested.
      const action = `fetch: ${call.rationale}`;
      const reason = "Sun asks before requesting a URL. This leaves your machine.";
      await this.sink({ type: "approval", action, reason });
      const approved = await this.approval.confirm({
        action,
        reason,
        command: String(call.input.url ?? ""),
      });
      result = approved
        ? await this.#tools.execute(call)
        : { ok: false, summary: "Fetch skipped", output: "" };
    } else {
      result = await this.#tools.execute(call);
    }

    this.#events.push({ type: "tool_result", content: { call, result } });
    await this.sink({ type: "tool_end", call, result });

    if (call.tool !== "read" && call.tool !== "publish") {
      const changes = await repositoryChanges(this.config, baseline);
      await this.sink({
        type: "diff",
        files: changes.files,
        patch: changes.diff,
      });
    }
  }

  /**
   * The only path out of the sandbox. The plan is resolved first so the user
   * approves a named remote and a specific commit rather than the word
   * "publish", and the approval cannot be delegated to auto mode.
   */
  async #publish(call: ToolCall): Promise<ToolResult> {
    let plan: PublishPlan;
    try {
      plan = await this.#tools.planPublish(call.input);
    } catch (error) {
      return {
        ok: false,
        summary: error instanceof Error ? error.message : String(error),
        output: "",
      };
    }

    const action = `publish: ${plan.remote}/${plan.branch}`;
    const reason =
      "Publishing runs Git outside Sun's sandbox, using your credentials and network access.";
    await this.sink({ type: "approval", action, reason });
    const approved = await this.approval.confirm({
      action,
      reason,
      command: plan.command,
      detail: describePlan(plan),
      alwaysAsk: true,
    });
    if (!approved) {
      return { ok: false, summary: "Publish declined", output: "" };
    }
    return await this.#tools.publish(plan);
  }

  #acceptSteering(): void {
    for (const message of this.drainSteering?.() ?? []) {
      this.#events.push({ type: "steering", content: message });
    }
  }

  async #finish(
    state: RunResult["state"],
    summary: string,
    baseline: RepositoryBaseline,
    goal: GoalVerdict | null = null,
  ): Promise<RunResult> {
    if (state === "blocked" && summary === "Interrupted by the user") {
      await this.sink({ type: "interrupted", reason: summary });
    }
    const changes = await repositoryChanges(this.config, baseline).catch(() => ({
      files: [],
      diff: "",
    }));
    await this.sink({
      type: "diff",
      files: changes.files,
      patch: changes.diff,
    });
    this.#events.push({ type: "assistant", content: summary });
    return {
      state,
      summary,
      filesChanged: changes.files,
      goal,
    };
  }
}
