import type {
  AgentContext,
  AgentDecision,
  ModelProvider,
} from "../core/types.ts";

export class ScriptedProvider implements ModelProvider {
  readonly contexts: AgentContext[] = [];
  readonly #decisions: AgentDecision[];

  constructor(decisions: AgentDecision[]) {
    this.#decisions = [...decisions];
  }

  async next(context: AgentContext): Promise<AgentDecision> {
    this.contexts.push(context);
    const decision = this.#decisions.shift();
    if (!decision) throw new Error("Scripted provider exhausted its decisions");
    return decision;
  }
}
