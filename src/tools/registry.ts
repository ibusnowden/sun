import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type {
  SunConfig,
  ToolCall,
  ToolName,
  ToolResult,
} from "../core/types.ts";
import { runProcess } from "../core/process.ts";
import { PathGuard } from "./path-guard.ts";

const schemas = {
  read: z.object({
    path: z.string().min(1),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  }),
  edit: z.object({
    path: z.string().min(1),
    oldText: z.string().min(1),
    newText: z.string(),
    expectedMatches: z.number().int().positive().default(1),
  }),
  write: z.object({
    path: z.string().min(1),
    content: z.string(),
    overwrite: z.boolean().default(false),
  }),
  bash: z.object({
    command: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
  }),
} satisfies Record<ToolName, z.ZodType>;

export class ToolRegistry {
  readonly #guard: PathGuard;

  private constructor(
    readonly config: SunConfig,
    guard: PathGuard,
  ) {
    this.#guard = guard;
  }

  static async create(config: SunConfig): Promise<ToolRegistry> {
    return new ToolRegistry(
      config,
      await PathGuard.create(config.repository),
    );
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    try {
      switch (call.tool) {
        case "read":
          return await this.#read(schemas.read.parse(call.input));
        case "edit":
          return await this.#edit(schemas.edit.parse(call.input));
        case "write":
          return await this.#write(schemas.write.parse(call.input));
        case "bash":
          return await this.#bash(schemas.bash.parse(call.input));
      }
    } catch (error) {
      return {
        ok: false,
        summary: error instanceof Error ? error.message : String(error),
        output: "",
      };
    }
  }

  async #read(input: z.infer<typeof schemas.read>): Promise<ToolResult> {
    const path = await this.#guard.resolve(input.path);
    const content = await readFile(path, "utf8");
    const lines = content.split("\n");
    const start = (input.startLine ?? 1) - 1;
    const end = input.endLine ?? lines.length;
    if (start >= lines.length || end < start + 1) {
      throw new Error(`Invalid line range for ${input.path}`);
    }
    const selected = lines.slice(start, end);
    const numbered = selected
      .map((line, index) => `${String(start + index + 1).padStart(5)} | ${line}`)
      .join("\n");
    const output = limit(numbered, this.config.maxOutputBytes);
    return {
      ok: true,
      summary: `Read ${selected.length} line(s) from ${input.path}`,
      output: output.value,
      truncated: output.truncated,
    };
  }

  async #edit(input: z.infer<typeof schemas.edit>): Promise<ToolResult> {
    const path = await this.#guard.resolve(input.path);
    const content = await readFile(path, "utf8");
    const matches = content.split(input.oldText).length - 1;
    if (matches !== input.expectedMatches) {
      throw new Error(
        `Expected ${input.expectedMatches} exact match(es) in ${input.path}, found ${matches}`,
      );
    }
    const firstMatch = content.indexOf(input.oldText);
    const startLine =
      content.slice(0, Math.max(0, firstMatch)).split("\n").length;
    await writeFile(path, content.replaceAll(input.oldText, input.newText));
    return {
      ok: true,
      summary: `Replaced ${matches} exact match(es) in ${input.path}`,
      output: "",
      metadata: { path: input.path, matches, startLine },
    };
  }

  async #write(input: z.infer<typeof schemas.write>): Promise<ToolResult> {
    const path = await this.#guard.resolve(input.path, { allowMissing: true });
    const existing = await Bun.file(path).exists();
    if (existing && !input.overwrite) {
      throw new Error(
        `${input.path} already exists; use edit or set overwrite explicitly`,
      );
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.content, existing ? undefined : { flag: "wx" });
    return {
      ok: true,
      summary: `${existing ? "Overwrote" : "Created"} ${input.path}`,
      output: "",
      metadata: {
        path: input.path,
        bytes: Buffer.byteLength(input.content),
        existing,
      },
    };
  }

  async #bash(input: z.infer<typeof schemas.bash>): Promise<ToolResult> {
    const timeoutMs = Math.min(
      input.timeoutMs ?? this.config.commandTimeoutMs,
      this.config.commandTimeoutMs,
    );
    const result = await runProcess(["bash", "-lc", input.command], {
      cwd: this.config.repository,
      timeoutMs,
      maxOutputBytes: this.config.maxOutputBytes,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      summary: result.timedOut
        ? `Command timed out after ${timeoutMs} ms`
        : `Command exited with code ${result.exitCode}`,
      output,
      exitCode: result.exitCode,
      truncated: result.truncated,
      metadata: {
        timedOut: result.timedOut,
      },
    };
  }
}

function limit(value: string, maxBytes: number): {
  value: string;
  truncated: boolean;
} {
  if (Buffer.byteLength(value) <= maxBytes) {
    return { value, truncated: false };
  }
  return {
    value: `${Buffer.from(value).subarray(0, maxBytes).toString()}\n[TRUNCATED]`,
    truncated: true,
  };
}
