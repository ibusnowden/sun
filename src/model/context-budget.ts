const CHARS_PER_TOKEN = 3;
const SAFETY_TOKENS = 8_192;

export function serializeForModel(
  input: unknown,
  options: {
    instructions: string;
    contextTokens: number;
    maxOutputTokens: number;
  },
): string {
  const availableTokens =
    options.contextTokens -
    options.maxOutputTokens -
    estimateTokens(options.instructions) -
    SAFETY_TOKENS;
  if (availableTokens < 1_024) {
    throw new Error(
      `Model context budget is too small: ${options.contextTokens} context tokens with ${options.maxOutputTokens} reserved for output`,
    );
  }
  const maxCharacters = availableTokens * CHARS_PER_TOKEN;
  let maxString = Math.min(32_768, maxCharacters);
  let maxArray = 500;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const serialized = JSON.stringify(
      compactValue(input, maxString, maxArray),
    );
    if (serialized.length <= maxCharacters) return serialized;
    maxString = Math.max(512, Math.floor(maxString / 2));
    maxArray = Math.max(8, Math.floor(maxArray / 2));
  }
  throw new Error(
    `Unable to fit model input inside the configured ${options.contextTokens}-token context window`,
  );
}

function compactValue(
  value: unknown,
  maxString: number,
  maxArray: number,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") return compactString(value, maxString);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === undefined
  ) {
    return value;
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    const selected =
      value.length <= maxArray
        ? value
        : [
            ...value.slice(0, Math.ceil(maxArray / 2)),
            `[${value.length - maxArray} ITEMS OMITTED]`,
            ...value.slice(-Math.floor(maxArray / 2)),
          ];
    return selected.map((item) =>
      compactValue(item, maxString, maxArray, seen),
    );
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      compactValue(item, maxString, maxArray, seen),
    ]),
  );
}

function compactString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const half = Math.floor((maxLength - 80) / 2);
  return `${value.slice(0, half)}\n[${value.length - half * 2} CHARACTERS OMITTED]\n${value.slice(-half)}`;
}

/**
 * Characters over a fixed divisor. Deliberately crude: it is used to budget
 * context and to attribute cost between tools, where the ratio between callers
 * matters and an exact count would need the model's own tokenizer.
 */
export function estimateTokens(value: string): number {
  return Math.ceil(value.length / CHARS_PER_TOKEN);
}
