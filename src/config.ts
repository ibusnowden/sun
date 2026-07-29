import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import type { SunConfig } from "./core/types.ts";

const DEFAULT_CONFIG = `# Sun configuration
provider = "openai-compatible"
model = "glm-5.2"
base_url = "http://127.0.0.1:4000/v1"
api_key_env = "SUN_API_KEY"
model_timeout_ms = 600000
model_max_tokens = 16384
model_context_tokens = 262144
max_tool_calls = 50
command_timeout_ms = 120000
max_output_bytes = 100000
stream_reasoning = true
`;

type TomlConfig = Partial<{
  provider: "openai" | "openai-compatible";
  model: string;
  base_url: string;
  api_key_env: string;
  model_timeout_ms: number;
  model_max_tokens: number;
  model_context_tokens: number;
  max_tool_calls: number;
  command_timeout_ms: number;
  max_output_bytes: number;
  stream_reasoning: boolean;
}>;

export async function initializeRepository(repository: string): Promise<string> {
  const agentDirectory = join(resolve(repository), ".agent");
  await mkdir(agentDirectory, { recursive: true });
  await writeIfMissing(join(agentDirectory, "config.toml"), DEFAULT_CONFIG);
  return agentDirectory;
}

export async function loadConfig(
  repository: string,
  overrides: Partial<
    Pick<
      SunConfig,
      | "model"
      | "provider"
      | "apiKeyEnv"
      | "maxToolCalls"
      | "workspaceMode"
    >
  > & { baseUrl?: string } = {},
): Promise<SunConfig> {
  const root = resolve(repository);
  const agentDirectory = await initializeRepository(root);
  const parsed = parse(
    await readFile(join(agentDirectory, "config.toml"), "utf8"),
  ) as TomlConfig;
  return {
    repository: root,
    workspaceMode: overrides.workspaceMode ?? false,
    agentDirectory,
    provider:
      overrides.provider ??
      parseProvider(process.env.SUN_PROVIDER) ??
      parsed.provider ??
      "openai-compatible",
    model: overrides.model ?? process.env.SUN_MODEL ?? parsed.model ?? "glm-5.2",
    baseUrl:
      overrides.baseUrl ??
      process.env.SUN_BASE_URL ??
      parsed.base_url ??
      "http://127.0.0.1:4000/v1",
    apiKeyEnv:
      overrides.apiKeyEnv ??
      process.env.SUN_API_KEY_ENV ??
      parsed.api_key_env ??
      "SUN_API_KEY",
    modelTimeoutMs: parsed.model_timeout_ms ?? 600_000,
    modelMaxTokens: parsed.model_max_tokens ?? 16_384,
    modelContextTokens: parsed.model_context_tokens ?? 262_144,
    maxToolCalls: overrides.maxToolCalls ?? parsed.max_tool_calls ?? 50,
    commandTimeoutMs: parsed.command_timeout_ms ?? 120_000,
    maxOutputBytes: parsed.max_output_bytes ?? 100_000,
    streamReasoning: parsed.stream_reasoning ?? true,
  };
}

function parseProvider(
  value: string | undefined,
): SunConfig["provider"] | undefined {
  if (value === undefined) return undefined;
  if (value === "openai" || value === "openai-compatible") return value;
  throw new Error(
    `SUN_PROVIDER must be "openai" or "openai-compatible", got "${value}"`,
  );
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(path, content, { flag: "wx" });
  }
}
