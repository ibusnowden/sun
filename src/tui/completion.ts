import { glyph, tone, truncate, visibleWidth } from "./theme.ts";

/**
 * Inline completion for the input box.
 *
 * Two triggers share one menu: `/` at the start of the line completes Sun's
 * commands, and `@` anywhere completes a workspace path. Completing a path
 * inserts text and nothing more — the agent still decides whether to read the
 * file with its own tool, so this stays a typing aid rather than a second,
 * competing way to put content into the context window.
 */

export type CompletionTrigger = "@" | "/";

export interface CompletionContext {
  trigger: CompletionTrigger;
  /** Index of the trigger character in the editor value. */
  start: number;
  query: string;
}

export interface CompletionItem {
  value: string;
  detail: string;
}

export const MAX_COMPLETION_ROWS = 8;

export const SLASH_COMMANDS: readonly CompletionItem[] = [
  { value: "goal", detail: "set or view the goal for a long-running task" },
  { value: "model", detail: "choose which model Sun runs on" },
  { value: "approvals", detail: "choose what Sun may run without asking" },
  { value: "plan", detail: "investigate and propose without changing anything" },
  { value: "usage", detail: "token activity: session, daily, weekly, cumulative" },
  { value: "diff", detail: "show git diff (including untracked files)" },
  { value: "files", detail: "list files Sun has touched" },
  { value: "help", detail: "show this list" },
  { value: "clear", detail: "clear the screen" },
  { value: "quit", detail: "exit Sun" },
] as const;

/**
 * The completion the caret currently sits in, if any. Returns null as soon as
 * the token is finished, so a trailing space dismisses the menu.
 */
export function completionContext(
  value: string,
  cursor: number,
): CompletionContext | null {
  const caret = Math.max(0, Math.min(value.length, cursor));

  if (value.startsWith("/") && !/\s/.test(value.slice(0, caret))) {
    return { trigger: "/", start: 0, query: value.slice(1, caret) };
  }

  for (let index = caret - 1; index >= 0; index -= 1) {
    const character = value[index] ?? "";
    if (/\s/.test(character)) return null;
    if (character !== "@") continue;
    const before = index === 0 ? "" : (value[index - 1] ?? "");
    if (before && !/[\s(\[]/.test(before)) return null;
    return { trigger: "@", start: index, query: value.slice(index + 1, caret) };
  }
  return null;
}

/** Rank candidates against a query, best first. */
export function rankCandidates(
  candidates: readonly CompletionItem[],
  query: string,
  limit = MAX_COMPLETION_ROWS,
): CompletionItem[] {
  if (!query) return candidates.slice(0, limit);
  const scored: Array<{ item: CompletionItem; score: number }> = [];
  for (const item of candidates) {
    const score = matchScore(item.value, query);
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((left, right) => {
    if (left.score !== right.score) return left.score - right.score;
    const byLength = left.item.value.length - right.item.value.length;
    if (byLength !== 0) return byLength;
    return left.item.value.localeCompare(right.item.value);
  });
  return scored.slice(0, limit).map((entry) => entry.item);
}

/**
 * Lower is better: a basename hit beats a path hit, and any literal hit beats
 * a scattered subsequence match.
 */
function matchScore(candidate: string, query: string): number | null {
  const haystack = candidate.toLowerCase();
  const needle = query.toLowerCase();
  const base = haystack.slice(haystack.lastIndexOf("/") + 1);

  if (haystack.startsWith(needle)) return 0;
  if (base.startsWith(needle)) return 1;
  if (base.includes(needle)) return 2;
  if (haystack.includes(needle)) return 3;
  if (isSubsequence(base, needle)) return 4;
  if (isSubsequence(haystack, needle)) return 5;
  return null;
}

function isSubsequence(haystack: string, needle: string): boolean {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return needle.length === 0;
}

/** Replace the in-progress token with the chosen completion. */
export function applyCompletion(
  value: string,
  cursor: number,
  context: CompletionContext,
  item: CompletionItem,
): { value: string; cursor: number } {
  const caret = Math.max(0, Math.min(value.length, cursor));
  // A path keeps typing afterwards, so it gets a separating space; a command
  // is the whole line and should be submittable straight away.
  const insertion =
    context.trigger === "@" ? `@${item.value} ` : `/${item.value}`;
  const next = value.slice(0, context.start) + insertion + value.slice(caret);
  return { value: next, cursor: context.start + insertion.length };
}

export function renderCompletionMenu(
  items: readonly CompletionItem[],
  selected: number,
  trigger: CompletionTrigger,
  width: number,
): string[] {
  if (items.length === 0) return [];
  const usable = Math.max(8, width);
  const labels = items.map((item) =>
    trigger === "/" ? `/${item.value}` : item.value,
  );
  // The description column starts past the longest label, slash included.
  const nameWidth = Math.min(
    Math.max(...labels.map((label) => visibleWidth(label))) + 2,
    Math.max(8, usable - 12),
  );

  return items.map((item, index) => {
    const active = index === selected;
    const marker = active ? tone.info(glyph.user) : " ";
    const plain = labels[index] ?? "";
    const label = paintLabel(plain, active, trigger);
    // Padding is measured on the unpainted label: colour escapes occupy no
    // columns, so padding the painted string would short the gap.
    const gap = Math.max(1, nameWidth - visibleWidth(plain));
    const body = item.detail
      ? `${label}${" ".repeat(gap)}${tone.muted(item.detail)}`
      : label;
    return `${marker} ${truncate(body, usable - 2)}`;
  });
}

/** Directories stay dim so the file name is what the eye lands on. */
function paintLabel(
  label: string,
  active: boolean,
  trigger: CompletionTrigger,
): string {
  if (active) return tone.selected(label);
  if (trigger === "/") return label;
  const cut = label.lastIndexOf("/");
  if (cut === -1) return label;
  return `${tone.detail(label.slice(0, cut + 1))}${label.slice(cut + 1)}`;
}
