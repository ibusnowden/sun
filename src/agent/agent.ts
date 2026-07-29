import type {
  AgentEvent,
  ApprovalHandler,
  EventSink,
  ModelProvider,
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

/** Sun's complete agent loop: decide, run one tool, feed the result back. */
export class Agent {
  readonly #events: AgentEvent[];
  readonly #tools: ToolRegistry;
  #toolCalls = 0;

  private constructor(
    readonly config: SunConfig,
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
    provider: ModelProvider;
    approval: ApprovalHandler;
    sink?: EventSink;
    drainSteering?: () => string[];
    signal?: AbortSignal;
    history?: AgentEvent[];
  }): Promise<Agent> {
    return new Agent(
      options.config,
      options.provider,
      options.approval,
      options.sink ?? (() => {}),
      options.drainSteering ?? null,
      options.signal ?? null,
      await ToolRegistry.create(options.config),
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
    if (call.tool === "bash") {
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
    } else {
      result = await this.#tools.execute(call);
    }

    this.#events.push({ type: "tool_result", content: { call, result } });
    await this.sink({ type: "tool_end", call, result });

    if (call.tool !== "read") {
      const changes = await repositoryChanges(this.config, baseline);
      await this.sink({
        type: "diff",
        files: changes.files,
        patch: changes.diff,
      });
    }
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
