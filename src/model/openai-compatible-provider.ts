import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type {
  AgentContext,
  AgentDecision,
  ModelProvider,
  ModelUsage,
  ProviderObserver,
} from "../core/types.ts";
import { serializeForModel } from "./context-budget.ts";
import { decisionEnvelopeSchema } from "./schemas.ts";

export class OpenAICompatibleProvider implements ModelProvider {
  readonly #client: OpenAI;
  readonly #observer: ProviderObserver | null;
  readonly #instructions: string;
  #streaming: boolean;
  #signal: AbortSignal | null = null;

  private constructor(
    readonly model: string,
    readonly maxTokens: number,
    readonly contextTokens: number,
    instructions: string,
    options: {
      baseUrl: string;
      apiKey: string;
      timeoutMs: number;
      streaming?: boolean;
      observer?: ProviderObserver;
    },
  ) {
    this.#instructions = instructions;
    this.#client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl.replace(/\/+$/, ""),
      timeout: options.timeoutMs,
      maxRetries: 1,
    });
    this.#streaming = options.streaming ?? true;
    this.#observer = options.observer ?? null;
  }

  static async create(options: {
    model: string;
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
    maxTokens: number;
    contextTokens: number;
    streaming?: boolean;
    observer?: ProviderObserver;
  }): Promise<OpenAICompatibleProvider> {
    return new OpenAICompatibleProvider(
      options.model,
      options.maxTokens,
      options.contextTokens,
      await loadInstructions(),
      options,
    );
  }

  setAbortSignal(signal: AbortSignal | null): void {
    this.#signal = signal;
  }

  async next(context: AgentContext): Promise<AgentDecision> {
    const body = {
      model: this.model,
      messages: [
        { role: "system" as const, content: this.#instructions },
        {
          role: "user" as const,
          content: serializeForModel(
            {
              ...context,
              observation: {
                ...context.observation,
                files: context.observation.files.slice(0, 500),
              },
            },
            {
              instructions: this.#instructions,
              contextTokens: this.contextTokens,
              maxOutputTokens: this.maxTokens,
            },
          ),
        },
      ],
      response_format: zodResponseFormat(
        decisionEnvelopeSchema,
        "sun_decision",
      ),
      max_tokens: this.maxTokens,
    };

    this.#observer?.onPhaseStart?.("decide");
    const startedAt = Date.now();
    let usage: ModelUsage | null = null;
    let failed = true;
    try {
      let completion: CompletionLike | null = null;
      if (this.#streaming) {
        try {
          const stream = this.#client.chat.completions.stream(
            { ...body, stream_options: { include_usage: true } },
            this.#requestOptions(),
          );
          stream.on("chunk", (chunk) => {
            const delta = chunk.choices[0]?.delta as
              | { reasoning_content?: string | null }
              | undefined;
            if (delta?.reasoning_content) {
              this.#observer?.onThinking?.(
                "decide",
                delta.reasoning_content,
              );
            }
          });
          completion = await stream.finalChatCompletion();
        } catch (error) {
          if (isAbortError(error) || this.#signal?.aborted) throw error;
          this.#streaming = false;
        }
      }
      completion ??= await this.#client.chat.completions.parse(
        { ...body, stream: false },
        this.#requestOptions(),
      );
      usage = modelUsage(completion.usage, this.contextTokens);
      const message = completion.choices[0]?.message;
      if (!message?.parsed) {
        throw new Error("Compatible model returned no parsed tool decision");
      }
      const envelope = decisionEnvelopeSchema.parse(message.parsed);
      const decision = envelope.decision;
      failed = false;
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

  #requestOptions(): { signal?: AbortSignal } {
    return this.#signal ? { signal: this.#signal } : {};
  }
}

interface CompletionLike {
  choices: Array<{
    message?: { parsed?: unknown; refusal?: string | null } | undefined;
  }>;
  usage?:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      }
    | null;
}

function modelUsage(
  usage: CompletionLike["usage"],
  contextTokens: number,
): ModelUsage | null {
  if (!usage) return null;
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
    contextTokens,
  };
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "APIUserAbortError")
  );
}

async function loadInstructions(): Promise<string> {
  const load = async (name: string): Promise<string> =>
    await readFile(
      fileURLToPath(new URL(`../../prompts/${name}.md`, import.meta.url)),
      "utf8",
    );
  const [system, actor] = await Promise.all([
    load("system"),
    load("actor"),
  ]);
  return `${system}\n\n${actor}`;
}
