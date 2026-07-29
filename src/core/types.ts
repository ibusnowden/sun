import type { GoalVerdict } from "../agent/goal.ts";

export type RunMode = "work";
export type ProviderKind = "openai" | "openai-compatible";
export type ToolName = "read" | "edit" | "write" | "bash";

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
}

export interface ApprovalHandler {
  confirm(request: ApprovalRequest): Promise<boolean>;
}

export interface ModelProvider {
  next(context: AgentContext): Promise<AgentDecision>;
  setAbortSignal?(signal: AbortSignal | null): void;
}
