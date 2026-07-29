import actor from "../../prompts/actor.md" with { type: "text" };
import system from "../../prompts/system.md" with { type: "text" };

/**
 * The system prompt, embedded at build time rather than read from disk.
 *
 * These used to be `readFile` calls resolved through `import.meta.url`, which
 * works from a source checkout and breaks the moment the tree is left behind:
 * inside a `bun build --compile` binary `import.meta.url` resolves to a
 * virtual root, so the lookup became `/prompts/system.md` and every run died
 * before it reached the model. Importing them as text makes the prompts part
 * of the bundle, so a single-file binary carries its own instructions.
 */
export function instructions(): string {
  return `${system}\n\n${actor}`;
}
