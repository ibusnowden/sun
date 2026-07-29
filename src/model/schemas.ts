import { z } from "zod";

const readCall = z.object({
  tool: z.literal("read"),
  rationale: z.string().min(1),
  input: z.object({
    path: z.string().min(1),
    startLine: z.number().int().positive().nullable(),
    endLine: z.number().int().positive().nullable(),
  }),
});

const editCall = z.object({
  tool: z.literal("edit"),
  rationale: z.string().min(1),
  input: z.object({
    path: z.string().min(1),
    oldText: z.string().min(1),
    newText: z.string(),
    expectedMatches: z.number().int().positive(),
  }),
});

const writeCall = z.object({
  tool: z.literal("write"),
  rationale: z.string().min(1),
  input: z.object({
    path: z.string().min(1),
    content: z.string(),
    overwrite: z.boolean(),
  }),
});

const bashCall = z.object({
  tool: z.literal("bash"),
  rationale: z.string().min(1),
  input: z.object({
    command: z.string().min(1),
    timeoutMs: z.number().int().positive().nullable(),
  }),
});

export const decisionEnvelopeSchema = z.object({
  decision: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("tool"),
      call: z.discriminatedUnion("tool", [
        readCall,
        editCall,
        writeCall,
        bashCall,
      ]),
    }),
    z.object({
      kind: z.literal("complete"),
      summary: z.string().min(1),
      // Only meaningful under an active goal, and only ever advisory: the
      // session loop decides what the verdict costs. Null on a normal task.
      goal: z.enum(["achieved", "continue", "blocked"]).nullable(),
    }),
    z.object({
      kind: z.literal("blocked"),
      reason: z.string().min(1),
    }),
  ]),
});
