import type { GoalVerdict } from "../agent/goal.ts";

/** `plan` investigates and proposes; only `work` may change anything. */
export type RunMode = "work" | "plan";
export type ProviderKind = "openai" | "openai-compatible";
export type ToolName =
  | "read"
  | "edit"
  | "write"
  | "bash"
  | "fetch"
  | "publish";

export interface SunConfig {
  repository: string;
  workspaceMode: boolean;
  agentDirectory: string;
  provider: ProviderKind;
  model: string;
  baseUrl: string | null;
  apiKeyEnv: string;
  modelTimeoutMs: number;
  modelMaxTokens: number;
  modelContextTokens: number;
  maxToolCalls: number;
  commandTimeoutMs: number;
  maxOutputBytes: number;
  streamReasoning: boolean;
}

export interface ToolCall {
  tool: ToolName;
  rationale: string;
  input: Record<string, unknown>;
}

export type AgentDecision =
  | { kind: "tool"; call: ToolCall }
  | { kind: "complete"; summary: string; goal?: GoalVerdict | null }
  | { kind: "blocked"; reason: string };

export interface ToolResult {
  ok: boolean;
  summary: string;
  output: string;
  exitCode?: number;
  truncated?: boolean;
  metadata?: Record<string, unknown>;
  /**
   * Estimated tokens this result adds to the next prompt. Stamped by the tool
   * registry, which is the only place that sees the output before the model.
   */
  outputTokens?: number;
}

/** What one tool has cost, accumulated by the registry. */
export interface ToolUsage {
  tool: ToolName;
  calls: number;
  failures: number;
  /** Results that came back clipped, and so cost less than they could have. */
  truncated: number;
  outputTokens: number;
}

export interface RepositoryObservation {
  root: string;
  gitStatus: string;
  files: string[];
}

export interface AgentEvent {
  type: "user" | "assistant" | "tool_call" | "tool_result" | "steering";
  content: unknown;
}

export interface AgentContext {
  task: string;
  observation: RepositoryObservation;
  recentEvents: AgentEvent[];
  toolCalls: number;
}

export type ModelPhase = "decide";

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextTokens: number;
}

/** Session token accounting, accumulated from every model call. */
export interface TokenLedger {
  /** Model calls that reported usage. */
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** The most recent call, for "what did that turn cost me". */
  last: ModelUsage | null;
  /** Largest prompt seen, which is what actually approaches the window. */
  peakPromptTokens: number;
  /** Window size the provider reported; 0 when nothing has been reported. */
  contextTokens: number;
}

export interface ProviderObserver {
  onPhaseStart?(phase: ModelPhase): void;
  onThinking?(phase: ModelPhase, delta: string): void;
  onPhaseEnd?(
    phase: ModelPhase,
    info: { durationMs: number; usage: ModelUsage | null; failed: boolean },
  ): void;
}

export type RuntimeEvent =
  | { type: "model_start"; phase: ModelPhase }
  | { type: "thinking"; phase: ModelPhase; delta: string }
  | {
      type: "model_end";
      phase: ModelPhase;
      durationMs: number;
      usage: ModelUsage | null;
      failed: boolean;
    }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_end"; call: ToolCall; result: ToolResult }
  | { type: "diff"; files: string[]; patch: string }
  | { type: "approval"; action: string; reason: string }
  | { type: "interrupted"; reason: string };

export type EventSink = (event: RuntimeEvent) => void | Promise<void>;

export interface RunResult {
  state: "complete" | "blocked";
  summary: string;
  filesChanged: string[];
  /** The model's verdict on the active goal, when one was being pursued. */
  goal?: GoalVerdict | null;
}

export interface ApprovalRequest {
  action: string;
  reason: string;
  command?: string;
  /**
   * Detail the user must see before deciding, such as the exact commits a
   * push would publish. Rendered above the choices.
   */
  detail?: string[];
  /**
   * Set for actions that leave the sandbox. Neither `/approvals` auto mode nor
   * a remembered "stop asking" answer may stand in for the user here.
   */
  alwaysAsk?: boolean;
}

export interface ApprovalHandler {
  confirm(request: ApprovalRequest): Promise<boolean>;
}

export interface ModelProvider {
  next(context: AgentContext): Promise<AgentDecision>;
  setAbortSignal?(signal: AbortSignal | null): void;
}
