import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type {
  AgentContext,
  AgentDecision,
  ModelProvider,
  ModelUsage,
  ProviderObserver,
} from "../core/types.ts";
import { serializeForModel } from "./context-budget.ts";
import { instructions } from "./instructions.ts";
import { decisionEnvelopeSchema } from "./schemas.ts";

export class OpenAIProvider implements ModelProvider {
  readonly #client: OpenAI;
  readonly #observer: ProviderObserver | null;
  readonly #instructions: string;
  #signal: AbortSignal | null = null;

  private constructor(
    readonly model: string,
    readonly maxTokens: number,
    readonly contextTokens: number,
    instructions: string,
    apiKey: string,
    observer: ProviderObserver | null,
  ) {
    this.#client = new OpenAI({ apiKey });
    this.#instructions = instructions;
    this.#observer = observer;
  }

  static async create(options: {
    model: string;
    apiKey?: string;
    maxTokens?: number;
    contextTokens?: number;
    observer?: ProviderObserver;
  }): Promise<OpenAIProvider> {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is required");
    return new OpenAIProvider(
      options.model,
      options.maxTokens ?? 16_384,
      options.contextTokens ?? 262_144,
      instructions(),
      apiKey,
      options.observer ?? null,
    );
  }

  setAbortSignal(signal: AbortSignal | null): void {
    this.#signal = signal;
  }

  async next(context: AgentContext): Promise<AgentDecision> {
    this.#observer?.onPhaseStart?.("decide");
    const startedAt = Date.now();
    let usage: ModelUsage | null = null;
    let failed = true;
    try {
      const response = await this.#client.responses.parse(
        {
          model: this.model,
          instructions: this.#instructions,
          input: serializeForModel(context, {
            instructions: this.#instructions,
            contextTokens: this.contextTokens,
            maxOutputTokens: this.maxTokens,
          }),
          max_output_tokens: this.maxTokens,
          text: {
            format: zodTextFormat(decisionEnvelopeSchema, "sun_decision"),
            verbosity: "low",
          },
          store: false,
        },
        this.#signal ? { signal: this.#signal } : {},
      );
      if (response.usage) {
        usage = {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
          totalTokens: response.usage.total_tokens,
          contextTokens: this.contextTokens,
        };
      }
      if (!response.output_parsed) {
        throw new Error("Model returned no parsed tool decision");
      }
      const envelope = decisionEnvelopeSchema.parse(response.output_parsed);
      failed = false;
      const decision = envelope.decision;
      if (decision.kind !== "tool") return decision;
      return {
        ...decision,
        call: {
          ...decision.call,
          input: Object.fromEntries(
            Object.entries(decision.call.input).filter(
              ([, value]) => value !== null,
            ),
          ),
        },
      };
    } finally {
      this.#observer?.onPhaseEnd?.("decide", {
        durationMs: Date.now() - startedAt,
        usage,
        failed,
      });
    }
  }
}
