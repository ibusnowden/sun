import type {
  ModelProvider,
  ProviderObserver,
  SunConfig,
} from "../core/types.ts";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.ts";
import { OpenAIProvider } from "./openai-provider.ts";

export async function createModelProvider(
  config: SunConfig,
  observer?: ProviderObserver,
): Promise<ModelProvider> {
  if (config.provider === "openai-compatible") {
    if (!config.baseUrl) {
      throw new Error(
        "base_url or SUN_BASE_URL is required for the openai-compatible provider",
      );
    }
    const apiKey = process.env[config.apiKeyEnv] ?? "local";
    return await OpenAICompatibleProvider.create({
      model: config.model,
      baseUrl: config.baseUrl,
      apiKey,
      timeoutMs: config.modelTimeoutMs,
      maxTokens: config.modelMaxTokens,
      contextTokens: config.modelContextTokens,
      streaming: config.streamReasoning,
      ...(observer ? { observer } : {}),
    });
  }

  const apiKey = process.env[config.apiKeyEnv] ?? process.env.OPENAI_API_KEY;
  return await OpenAIProvider.create({
    model: config.model,
    maxTokens: config.modelMaxTokens,
    contextTokens: config.modelContextTokens,
    ...(apiKey ? { apiKey } : {}),
    ...(observer ? { observer } : {}),
  });
}
