import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentContext,
  ModelUsage,
} from "../src/core/types.ts";
import { OpenAICompatibleProvider } from "../src/model/openai-compatible-provider.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

type RequestBody = {
  stream?: boolean;
  response_format?: {
    type?: string;
    json_schema?: { name?: string };
  };
};

describe("OpenAICompatibleProvider", () => {
  test("uses one structured Chat Completions decision endpoint", async () => {
    const requests: Array<{
      path: string;
      authorization: string | null;
      body: RequestBody;
    }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as RequestBody;
        requests.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          body,
        });
        return Response.json(completion());
      },
    });
    servers.push(server);
    const provider = await createProvider(server, { streaming: false });

    expect(await provider.next(context())).toEqual({
      kind: "blocked",
      reason: "Need a test fixture",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/v1/chat/completions");
    expect(requests[0]?.authorization).toBe("Bearer local");
    expect(requests[0]?.body.response_format?.type).toBe("json_schema");
    expect(requests[0]?.body.response_format?.json_schema?.name).toBe(
      "sun_decision",
    );
  });

  test("streams hidden reasoning and reports token usage", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        return streamedResponse();
      },
    });
    servers.push(server);
    const thinking: string[] = [];
    const usages: Array<ModelUsage | null> = [];
    const provider = await createProvider(server, {
      observer: {
        onThinking: (_phase, delta) => thinking.push(delta),
        onPhaseEnd: (_phase, info) => usages.push(info.usage),
      },
    });

    await provider.next(context());

    expect(thinking.join("")).toBe("checking the file");
    expect(usages[0]).toEqual({
      promptTokens: 10,
      completionTokens: 10,
      totalTokens: 20,
      contextTokens: 262_144,
    });
  });

  test("falls back once when streaming is unsupported", async () => {
    let streamAttempts = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as RequestBody;
        if (body.stream) {
          streamAttempts += 1;
          return new Response("streaming unsupported", { status: 400 });
        }
        return Response.json(completion());
      },
    });
    servers.push(server);
    const provider = await createProvider(server);

    await provider.next(context());
    await provider.next(context());

    expect(streamAttempts).toBe(1);
  });

  test("an aborted signal cancels without retrying", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(2_000);
        return Response.json({});
      },
    });
    servers.push(server);
    const provider = await createProvider(server);
    const controller = new AbortController();
    provider.setAbortSignal(controller.signal);
    const pending = provider.next(context());
    setTimeout(() => controller.abort(), 50);

    await expect(pending).rejects.toThrow();
  });
});

async function createProvider(
  server: ReturnType<typeof Bun.serve>,
  options: {
    streaming?: boolean;
    observer?: Parameters<
      typeof OpenAICompatibleProvider.create
    >[0]["observer"];
  } = {},
): Promise<OpenAICompatibleProvider> {
  return await OpenAICompatibleProvider.create({
    model: "glm-5.2",
    baseUrl: `${server.url}v1`,
    apiKey: "local",
    timeoutMs: 5_000,
    maxTokens: 1_000,
    contextTokens: 262_144,
    ...(options.streaming !== undefined
      ? { streaming: options.streaming }
      : {}),
    ...(options.observer ? { observer: options.observer } : {}),
  });
}

function completion(): unknown {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "glm-5.2",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify({
            decision: { kind: "blocked", reason: "Need a test fixture" },
          }),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
}

function streamedResponse(): Response {
  const chunk = (delta: unknown, extra: Record<string, unknown> = {}): string =>
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "glm-5.2",
      choices: [{ index: 0, delta, finish_reason: null }],
      ...extra,
    })}\n\n`;
  const content = JSON.stringify({
    decision: { kind: "blocked", reason: "Need a test fixture" },
  });
  return new Response(
    [
      chunk({ role: "assistant", reasoning_content: "checking " }),
      chunk({ reasoning_content: "the file" }),
      chunk({ content }),
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "glm-5.2",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function context(): AgentContext {
  return {
    task: "test",
    observation: {
      root: "/tmp/repo",
      gitStatus: "## main",
      files: ["src/index.ts"],
    },
    recentEvents: [],
    toolCalls: 0,
  };
}
