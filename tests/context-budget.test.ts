import { describe, expect, test } from "bun:test";
import { serializeForModel } from "../src/model/context-budget.ts";

describe("serializeForModel", () => {
  test("preserves small structured inputs", () => {
    const input = { task: "inspect", files: ["a.ts", "b.ts"] };
    const result = serializeForModel(input, {
      instructions: "Follow the plan.",
      contextTokens: 262_144,
      maxOutputTokens: 16_384,
    });
    expect(JSON.parse(result)).toEqual(input);
  });

  test("compacts oversized tool output within the context budget", () => {
    const result = serializeForModel(
      {
        task: "diagnose",
        output: `BEGIN-${"x".repeat(200_000)}-END`,
      },
      {
        instructions: "Inspect the evidence.",
        contextTokens: 16_384,
        maxOutputTokens: 1_024,
      },
    );
    const parsed = JSON.parse(result) as { output: string };
    expect(result.length).toBeLessThan(22_000);
    expect(parsed.output).toStartWith("BEGIN-");
    expect(parsed.output).toEndWith("-END");
    expect(parsed.output).toContain("CHARACTERS OMITTED");
  });
});
