import type {
  ToolCall,
  ToolName,
  ToolResult,
} from "../core/types.ts";
import { describeStatus, type Goal } from "../agent/goal.ts";
import { SLASH_COMMANDS } from "./completion.ts";
import { renderMarkdown } from "./markdown.ts";
import {
  formatCount,
  formatDuration,
  formatTokens,
  glyph,
  pad,
  tone,
  truncate,
  visibleWidth,
  wrap,
} from "./theme.ts";

/**
 * The scrollback half of the interface.
 *
 * One bullet per event at column 0, detail indented under it, and two
 * connectors — `│` for a command that wrapped, `└` for the head of its output.
 * `design/codex-ui.md` records the grammar these renderers implement.
 */

/** Continuation of a bullet: aligns under the text, not under the bullet. */
const BODY = "  ";
/** Command output and diff rows sit one step deeper still. */
const DETAIL = "    ";
/** Output lines shown before the rest is elided. */
const OUTPUT_LINES = 6;
/** Output lines kept from the tail when a command failed. */
const FAILURE_LINES = 10;

export interface DiffStats {
  additions: number;
  deletions: number;
}

/** How each tool names itself in the transcript. */
const TOOL_VERB: Record<ToolName, string> = {
  read: "Read",
  edit: "Edited",
  write: "Created",
  bash: "Ran",
};

function bullet(text: string, width: number, paint = (v: string) => v): string[] {
  const body = wrap(text, Math.max(1, width - 2));
  return body.map((line, index) =>
    index === 0
      ? `${tone.muted(glyph.bullet)} ${paint(line)}`
      : `${BODY}${paint(line)}`,
  );
}

export function renderTask(task: string, width: number): string[] {
  const body = wrap(task, Math.max(1, width - 2));
  return [
    "",
    ...body.map(
      (line, index) =>
        `${index === 0 ? tone.info(glyph.user) : " "} ${tone.heading(line)}`,
    ),
    "",
  ];
}

export function renderAssistant(message: string, width: number): string[] {
  if (!message.trim()) return [];
  const body = renderMarkdown(message, Math.max(1, width - 2));
  return [
    ...body.map((line, index) => {
      if (index > 0 && !line) return "";
      return index === 0
        ? `${tone.muted(glyph.bullet)} ${line}`
        : `${BODY}${line}`;
    }),
    "",
  ];
}

/**
 * The narration Sun prints when a tool starts. It reads as the agent talking,
 * so it takes the same bullet as a finished answer.
 */
export function renderNarration(text: string, width: number): string[] {
  if (!text.trim()) return [];
  return [...bullet(text, width), ""];
}

export function renderToolEnd(
  call: ToolCall,
  result: ToolResult,
  width: number,
  durationMs?: number,
): string[] {
  const verb =
    call.tool === "write" && result.metadata?.existing
      ? "Overwrote"
      : TOOL_VERB[call.tool];
  const headline = `${verb} ${describeCall(call)}`;
  const stat = toolStat(call, result, durationMs);
  const lines = commandHeadline(headline, stat, result.ok, width);

  if (!result.ok) {
    // The exit code is already on the headline, so a command only needs to
    // show what it printed. Other tools have no output, and their summary is
    // the whole explanation.
    const output = splitOutput(result.output);
    const detail =
      call.tool === "bash" && output.length > 0
        ? output.slice(-FAILURE_LINES)
        : [result.summary || "failed"];
    lines.push(
      ...outputBlock(
        detail,
        width,
        tone.failed,
        call.tool === "bash" ? output.length - FAILURE_LINES : 0,
      ),
    );
    return lines;
  }

  if (call.tool === "bash") {
    const output = splitOutput(result.output);
    lines.push(
      ...outputBlock(
        output.slice(0, OUTPUT_LINES),
        width,
        tone.muted,
        output.length - OUTPUT_LINES,
      ),
    );
  }
  if (result.truncated) {
    lines.push(`${DETAIL}${tone.muted("output truncated")}`);
  }
  return lines;
}

/**
 * The bullet line for a tool. A long command wraps onto `│` continuations so
 * the whole thing stays readable instead of being clipped to one row.
 */
function commandHeadline(
  headline: string,
  stat: string,
  ok: boolean,
  width: number,
): string[] {
  const suffix = stat ? ` (${stat})` : "";
  // Continuation rows carry a four-column prefix, so the text is wrapped to
  // fit the deeper of the two indents rather than the shallower one.
  const available = Math.max(4, width - 4 - visibleWidth(suffix));
  const wrapped = wrap(headline, available);
  const head = wrapped[0] ?? "";
  const rest = wrapped.slice(1);
  const marker = ok ? tone.muted(glyph.bullet) : tone.failed(glyph.bullet);

  return [
    truncate(
      `${marker} ${tone.heading(head)}${rest.length === 0 ? suffix : ""}`,
      width,
    ),
    ...rest.map((line, index) =>
      truncate(
        `${BODY}${tone.muted(glyph.continuation)} ${tone.detail(line)}${
          index === rest.length - 1 ? suffix : ""
        }`,
        width,
      ),
    ),
  ];
}

/**
 * A command's output. The first line takes the corner; the rest align under it
 * with plain spaces, which is what makes `└` read as a corner and not a list
 * bullet.
 */
function outputBlock(
  lines: string[],
  width: number,
  paint: (value: string) => string,
  hidden: number,
): string[] {
  const inner = Math.max(1, width - DETAIL.length);
  const rendered = lines
    .filter((line) => line.trim())
    .map((line) => truncate(line.replace(/\t/g, "  "), inner));
  if (rendered.length === 0) return [];
  const block = rendered.map((line, index) =>
    index === 0
      ? `${BODY}${tone.muted(glyph.corner)} ${paint(line)}`
      : `${DETAIL}${paint(line)}`,
  );
  if (hidden > 0) {
    block.push(
      `${DETAIL}${tone.muted(`${glyph.ellipsis} +${hidden} line${hidden === 1 ? "" : "s"}`)}`,
    );
  }
  return block;
}

function splitOutput(output: string): string[] {
  return output.split("\n").filter((line) => line.trim());
}

/** The parenthesised stat after a tool headline. */
function toolStat(
  call: ToolCall,
  result: ToolResult,
  durationMs?: number,
): string {
  if (!result.ok) {
    return result.exitCode === undefined ? "failed" : `exit ${result.exitCode}`;
  }
  if (call.tool === "read") {
    const count = /Read\s+(\d+)\s+line/i.exec(result.summary)?.[1];
    return count ? `${count} lines` : "";
  }
  if (call.tool === "edit") {
    // Counted on the trimmed edit, so the headline agrees with the rows
    // printed underneath it.
    const change = trimCommonEdges(
      String(call.input.oldText ?? "").split("\n"),
      String(call.input.newText ?? "").split("\n"),
    );
    return `${tone.added(`+${change.added.length}`)} ${tone.removed(`-${change.removed.length}`)}`;
  }
  if (call.tool === "write") {
    const added = String(call.input.content ?? "").split("\n").length;
    return `${tone.added(`+${added}`)} ${tone.removed("-0")}`;
  }
  return durationMs !== undefined && durationMs >= 1_000
    ? formatDuration(durationMs)
    : "";
}

export function describeCall(call: ToolCall): string {
  if (call.tool === "read") {
    const range =
      call.input.startLine || call.input.endLine
        ? `:${call.input.startLine ?? 1}-${call.input.endLine ?? ""}`
        : "";
    return `${String(call.input.path ?? "")}${range}`;
  }
  if (call.tool === "edit" || call.tool === "write") {
    return String(call.input.path ?? "");
  }
  return String(call.input.command ?? "");
}

export function diffStats(patch: string): DiffStats {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

export function perFileStats(patch: string): Map<string, DiffStats> {
  const stats = new Map<string, DiffStats>();
  let current: DiffStats | null = null;
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      current = { additions: 0, deletions: 0 };
      stats.set(header[2] ?? header[1] ?? "unknown", current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) current.additions += 1;
    if (line.startsWith("-")) current.deletions += 1;
  }
  return stats;
}

export function renderDiffSummary(
  files: string[],
  patch: string,
  width: number,
): string[] {
  if (files.length === 0) return [];
  const stats = perFileStats(patch);
  const total = diffStats(patch);
  // The headline goes through `wrap`, which strips colour, so its counter is
  // written plain rather than painted and silently flattened.
  const lines = bullet(
    `Working tree: ${formatCount(files.length, "file")}  +${total.additions} -${total.deletions}`,
    width,
  );
  const nameWidth = Math.max(
    4,
    Math.min(
      Math.max(...files.map((file) => file.length), 4),
      width - DETAIL.length - 10,
    ),
  );
  for (const file of files.slice(0, 12)) {
    const fileStats = stats.get(file) ?? { additions: 0, deletions: 0 };
    const name = truncate(file, nameWidth);
    const gap = Math.max(1, nameWidth - visibleWidth(name));
    lines.push(
      truncate(
        `${DETAIL}${tone.detail(name)}${" ".repeat(gap)}  ${changeCounter(fileStats)}`,
        width,
      ),
    );
  }
  if (files.length > 12) {
    lines.push(
      `${DETAIL}${tone.muted(`${glyph.ellipsis} +${files.length - 12} more`)}`,
    );
  }
  return ["", ...lines, ""];
}

function changeCounter(stats: DiffStats): string {
  return `${tone.added(`+${stats.additions}`)} ${tone.removed(`-${stats.deletions}`)}`;
}

export function renderPatch(
  patch: string,
  width: number,
  maxLines = 120,
): string[] {
  if (!patch.trim()) return bullet("The working tree is unchanged.", width);
  const lines: string[] = [""];
  let shown = 0;
  let hidden = 0;
  for (const line of patch.split("\n")) {
    if (
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
    ) {
      continue;
    }
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      lines.push(
        `${BODY}${tone.heading(truncate(header[2] ?? "", Math.max(1, width - 2)))}`,
      );
      continue;
    }
    if (shown >= maxLines) {
      hidden += 1;
      continue;
    }
    shown += 1;
    lines.push(`${DETAIL}${paintPatchLine(line, width - 4)}`);
  }
  if (hidden > 0) {
    lines.push(`${DETAIL}${tone.muted(`${glyph.ellipsis} +${hidden} lines`)}`);
  }
  lines.push("");
  return lines;
}

interface InlineDiffEntry {
  file: string;
  kind: "added" | "removed";
  line: number;
  text: string;
}

/**
 * The numbered change preview. Each row is the line number, the sign, and the
 * code — the shape a reviewer already reads in a diff, at the indentation of
 * command output so an edit and a command sit on the same visual step.
 */
export function renderInlineDiff(
  patch: string,
  width: number,
  maxLines = 12,
): string[] {
  if (!patch.trim() || maxLines <= 0) return [];

  const entries: InlineDiffEntry[] = [];
  let file = "";
  let oldLine = 0;
  let newLine = 0;

  for (const rawLine of patch.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(rawLine);
    if (header) {
      file = header[2] ?? header[1] ?? "";
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunk) {
      oldLine = Number(hunk[1] ?? 0);
      newLine = Number(hunk[2] ?? 0);
      continue;
    }
    if (rawLine.startsWith("--- ") || rawLine.startsWith("+++ ")) continue;
    if (rawLine.startsWith("-") && file) {
      entries.push({ file, kind: "removed", line: oldLine, text: rawLine.slice(1) });
      oldLine += 1;
      continue;
    }
    if (rawLine.startsWith("+") && file) {
      entries.push({ file, kind: "added", line: newLine, text: rawLine.slice(1) });
      newLine += 1;
      continue;
    }
    if (rawLine.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }

  if (entries.length === 0) {
    return patch
      .split("\n")
      .filter((line) => line.trim())
      .slice(0, maxLines)
      .map(
        (line) =>
          `${DETAIL}${tone.muted(truncate(line.replace(/\t/g, "  "), Math.max(1, width - 4)))}`,
      );
  }

  const selected = selectDiffEntries(entries, maxLines);
  const numberWidth = Math.min(
    6,
    Math.max(1, ...selected.map((entry) => String(entry.line).length)),
  );
  const lines: string[] = [];
  let previousFile = "";

  for (const entry of selected) {
    if (entry.file !== previousFile && entries.some((other) => other.file !== entry.file)) {
      lines.push(
        `${DETAIL}${tone.heading(truncate(entry.file, Math.max(1, width - 4)))}`,
      );
      previousFile = entry.file;
    }
    lines.push(renderInlineDiffEntry(entry, numberWidth, width));
  }

  const hidden = entries.length - selected.length;
  if (hidden > 0) {
    lines.push(
      `${DETAIL}${tone.muted(`${glyph.ellipsis} +${hidden} changed line${hidden === 1 ? "" : "s"}`)}`,
    );
  }
  return lines;
}

/**
 * A replacement lists every removed line before every added one, so a plain
 * head of the list would show only deletions. Split the budget instead: the
 * preview of a large rewrite has to include the code that replaced the old.
 */
function selectDiffEntries(
  entries: InlineDiffEntry[],
  maxLines: number,
): InlineDiffEntry[] {
  if (entries.length <= maxLines) return entries;
  const removed = entries.filter((entry) => entry.kind === "removed");
  const added = entries.filter((entry) => entry.kind === "added");
  if (removed.length === 0 || added.length === 0) {
    return entries.slice(0, maxLines);
  }
  const removedBudget = Math.min(removed.length, Math.floor(maxLines / 2));
  const kept = new Set<InlineDiffEntry>([
    ...removed.slice(0, removedBudget),
    ...added.slice(0, maxLines - removedBudget),
  ]);
  return entries.filter((entry) => kept.has(entry));
}

/** Exact edit/write preview that does not depend on the workspace being Git. */
export function renderToolChange(
  call: ToolCall,
  result: ToolResult,
  width: number,
): string[] {
  if (!result.ok || (call.tool !== "edit" && call.tool !== "write")) return [];
  const path = String(call.input.path ?? "");
  if (!path) return [];

  if (call.tool === "edit") {
    const startLine = Math.max(1, Number(result.metadata?.startLine ?? 1));
    const { context, removed, added } = trimCommonEdges(
      String(call.input.oldText ?? "").split("\n"),
      String(call.input.newText ?? "").split("\n"),
    );
    return [
      ...renderInlineDiff(
        [
          `diff --git a/${path} b/${path}`,
          `--- a/${path}`,
          `+++ b/${path}`,
          `@@ -${startLine + context},${removed.length} +${startLine + context},${added.length} @@`,
          ...removed.map((line) => `-${line}`),
          ...added.map((line) => `+${line}`),
        ].join("\n"),
        width,
      ),
    ];
  }

  const newLines = String(call.input.content ?? "").split("\n");
  return [
    ...renderInlineDiff(
      [
        `diff --git a/${path} b/${path}`,
        "--- /dev/null",
        `+++ b/${path}`,
        `@@ -0,0 +1,${newLines.length} @@`,
        ...newLines.map((line) => `+${line}`),
      ].join("\n"),
      width,
    ),
  ];
}

/**
 * An `edit` replaces one exact string with another, and the two usually share
 * their opening lines — appending to a block sends the whole block through as
 * both a removal and an addition. Dropping the shared head leaves the lines
 * that actually changed, which is the only part worth showing.
 */
function trimCommonEdges(
  oldLines: string[],
  newLines: string[],
): { context: number; removed: string[]; added: string[] } {
  let head = 0;
  while (
    head < oldLines.length &&
    head < newLines.length &&
    oldLines[head] === newLines[head]
  ) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }
  return {
    context: head,
    removed: oldLines.slice(head, oldLines.length - tail),
    added: newLines.slice(head, newLines.length - tail),
  };
}

function renderInlineDiffEntry(
  entry: InlineDiffEntry,
  numberWidth: number,
  width: number,
): string {
  const sign = entry.kind === "added" ? "+" : "-";
  const paint = entry.kind === "added" ? tone.added : tone.removed;
  const number = String(entry.line).padStart(numberWidth);
  const prefix = `${DETAIL}${tone.muted(number)} ${paint(sign)}`;
  const available = width - DETAIL.length - numberWidth - 2;
  if (available <= 0) return truncate(`${DETAIL}${number} ${sign}`, width);
  return `${prefix}${paint(truncate(entry.text.replace(/\t/g, "  "), available))}`;
}

function paintPatchLine(line: string, width: number): string {
  const clipped = truncate(line.replace(/\t/g, "  "), width);
  if (line.startsWith("@@")) return tone.info(clipped);
  if (line.startsWith("+")) return tone.added(clipped);
  if (line.startsWith("-")) return tone.removed(clipped);
  return tone.muted(clipped);
}

export function renderInterrupted(detail: string, width: number): string[] {
  return [
    ...bullet(`Interrupted ${glyph.ellipsis} ${detail}`, width, tone.failed),
    "",
  ];
}

export function renderNote(message: string, width: number): string[] {
  return bullet(message, width, tone.muted);
}

export function renderError(message: string, width: number): string[] {
  return ["", ...bullet(message, width, tone.failed), ""];
}

function renderRows(rows: Array<[string, string]>, width: number): string[] {
  const labelWidth = Math.max(0, ...rows.map(([label]) => label.length));
  return rows.flatMap(([label, value]) => {
    const prefix = `${BODY}${pad(label, labelWidth)}  `;
    const available = width - visibleWidth(prefix);
    if (available >= 8) {
      const body = wrap(value, available);
      return body.map((line, index) =>
        index === 0
          ? `${BODY}${tone.heading(pad(label, labelWidth))}  ${tone.muted(line)}`
          : `${" ".repeat(visibleWidth(prefix))}${tone.muted(line)}`,
      );
    }
    return [
      `${BODY}${tone.heading(label)}`,
      ...wrap(value, Math.max(1, width - 4)).map(
        (line) => `${DETAIL}${tone.muted(line)}`,
      ),
    ];
  });
}

export function renderHelp(width: number): string[] {
  // One list drives both the help screen and `/` completion, so they can't drift.
  const commands: Array<[string, string]> = SLASH_COMMANDS.map((command) => [
    `/${command.value}`,
    command.detail,
  ]);
  return [
    "",
    `${BODY}${tone.heading("Commands")}`,
    "",
    ...renderRows(commands, width),
    "",
    `${BODY}${tone.heading("Keys")}`,
    "",
    ...renderRows(
      [
        ["enter", "send a task, or queue steering while Sun works"],
        ["alt+enter", "insert a newline in the editor"],
        ["@", "complete a workspace path"],
        ["tab", "accept the highlighted completion"],
        ["esc", "clear the input, or interrupt the run"],
        ["ctrl+c", "clear the input, twice to exit"],
        ["↑ ↓", "browse input history, or move in a menu"],
        ["1-9", "pick a numbered row in a menu"],
      ],
      width,
    ),
    "",
  ];
}

export function renderFileList(
  files: Array<{ path: string; action: string; status: string }>,
  width: number,
): string[] {
  if (files.length === 0) return renderNote("No files touched yet.", width);
  const actionWidth = Math.max(
    1,
    Math.min(
      Math.max(...files.map((file) => file.action.length)),
      Math.max(1, width - DETAIL.length - 8),
    ),
  );
  return [
    "",
    ...bullet(`Files touched: ${files.length}`, width),
    ...files.map((file) => {
      const marker =
        file.status === "failed"
          ? tone.failed(glyph.failed)
          : file.status === "running"
            ? tone.running(glyph.bullet)
            : tone.ok(glyph.ok);
      const action = truncate(file.action, actionWidth);
      const gap = Math.max(1, actionWidth - visibleWidth(action));
      return truncate(
        `${DETAIL}${marker} ${tone.muted(action)}${" ".repeat(gap)}  ${tone.detail(file.path)}`,
        width,
      );
    }),
    "",
  ];
}

/**
 * The `/goal` status block. The objective is the one field that gets the full
 * width, because it is the thing the user is deciding whether to keep.
 */
export function renderGoalCard(goal: Goal, width: number): string[] {
  const status = describeStatus(goal.status);
  const paint =
    goal.status === "complete"
      ? tone.ok
      : goal.status === "blocked"
        ? tone.failed
        : goal.status === "active"
          ? tone.running
          : tone.warn;
  const rows: Array<[string, string]> = [
    ["objective", goal.objective],
    ["turns", String(goal.turns)],
    [
      "tokens",
      goal.tokenBudget === null
        ? formatTokens(goal.tokensUsed)
        : `${formatTokens(goal.tokensUsed)} / ${formatTokens(goal.tokenBudget)}`,
    ],
    ["elapsed", formatDuration(Date.now() - goal.createdAt)],
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  return [
    "",
    `${tone.muted(glyph.bullet)} ${tone.heading("Goal")} ${tone.muted("·")} ${paint(status)}`,
    ...rows.flatMap(([label, value]) => {
      const prefix = `${DETAIL}${pad(label, labelWidth)}  `;
      const available = Math.max(8, width - visibleWidth(prefix));
      return wrap(value, available).map((line, index) =>
        index === 0
          ? `${DETAIL}${tone.muted(pad(label, labelWidth))}  ${line}`
          : `${" ".repeat(visibleWidth(prefix))}${line}`,
      );
    }),
    "",
  ];
}

/**
 * The compact goal marker on the status line. Tokens appear only when there is
 * a budget to measure them against — the status line already carries a session
 * counter, and an unbudgeted goal would just print the same number twice.
 */
export function goalBadge(goal: Goal): string {
  const status = `goal ${describeStatus(goal.status)} · ${formatCount(goal.turns, "turn")}`;
  if (goal.tokenBudget === null) return status;
  return `${status} · ${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)}`;
}

export function alignRight(left: string, right: string, width: number): string {
  if (!right) return truncate(left, width);
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap < 1) return truncate(left, width);
  return `${left}${" ".repeat(gap)}${right}`;
}
