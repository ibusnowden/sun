import {
  formatTokens,
  glyph,
  pad,
  tone,
  truncate,
  visibleWidth,
} from "./theme.ts";

/**
 * The fixed furniture around the transcript: the header box Sun opens with,
 * the rule that separates turns, and the one-line status footer.
 *
 * See `design/codex-ui.md`. The header box is sized to its content rather than
 * to the terminal, so it stays a compact plate at the top of a wide window.
 */

const BOX = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
} as const;

/** Widest header the box is allowed to reach before its content is clipped. */
const MAX_BOX_WIDTH = 76;

const MODEL_HINT = "/model to change";

export interface HeaderView {
  name: string;
  version: string;
  model: string;
  repository: string;
  /** Shown under the box; omitted when empty. */
  tip?: string;
}

export function renderHeader(view: HeaderView, width: number): string[] {
  // The box spends four columns on its own border, so the content it can hold
  // is four narrower than the terminal.
  const limit = Math.max(4, Math.min(MAX_BOX_WIDTH, width - 4));
  const labelWidth = "directory:".length + 1;
  const label = (text: string): Row => ({
    plain: pad(text, labelWidth),
    painted: tone.muted(pad(text, labelWidth)),
  });
  const directory = middleTruncatePath(
    view.repository,
    limit - labelWidth,
  );

  const rows: Row[] = [
    row(`>_ ${view.name} (v${view.version})`, tone.brand),
    row("", (value) => value),
    join(label("model:"), row(view.model, (value) => value), {
      plain: `   ${MODEL_HINT}`,
      painted: `   ${tone.muted(MODEL_HINT)}`,
    }),
    join(label("directory:"), row(directory, tone.detail)),
  ];

  const content = Math.min(
    limit,
    Math.max(...rows.map((entry) => visibleWidth(entry.plain))),
  );
  const lines = [
    `${BOX.topLeft}${BOX.horizontal.repeat(content + 2)}${BOX.topRight}`,
    ...rows.map((entry) => {
      const missing = Math.max(0, content - visibleWidth(entry.plain));
      const body =
        missing > 0
          ? `${entry.painted}${" ".repeat(missing)}`
          : truncate(entry.painted, content);
      return `${BOX.vertical} ${body} ${BOX.vertical}`;
    }),
    `${BOX.bottomLeft}${BOX.horizontal.repeat(content + 2)}${BOX.bottomRight}`,
  ];

  if (!view.tip) return ["", ...lines, ""];
  return [
    "",
    ...lines,
    "",
    `  ${tone.muted(`Tip: ${truncate(view.tip, Math.max(1, width - 7))}`)}`,
    "",
  ];
}

/**
 * A header cell carries its own painted form. Width is always measured on
 * `plain`, because colour escapes are not columns and padding a painted string
 * would count them.
 */
interface Row {
  plain: string;
  painted: string;
}

function row(text: string, paint: (value: string) => string): Row {
  return { plain: text, painted: text ? paint(text) : "" };
}

function join(...parts: Row[]): Row {
  return {
    plain: parts.map((part) => part.plain).join(""),
    painted: parts.map((part) => part.painted).join(""),
  };
}

/**
 * Shorten a path from the middle, keeping the first two segments and as much
 * of the tail as fits. A workspace path is recognised by where it starts and
 * where it ends; the middle is the part nobody reads.
 */
export function middleTruncatePath(path: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(path) <= width) return path;

  const absolute = path.startsWith("/");
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 3) return truncate(path, width);

  const head = segments.slice(0, 2).join("/");
  for (let tailCount = segments.length - 2; tailCount >= 1; tailCount -= 1) {
    const tail = segments.slice(segments.length - tailCount).join("/");
    const candidate = `${absolute ? "/" : ""}${head}/${glyph.ellipsis}/${tail}`;
    if (visibleWidth(candidate) <= width) return candidate;
  }
  return truncate(path, width);
}

/** The full-width rule Codex draws between turns. */
export function renderRule(width: number): string {
  return tone.muted(BOX.horizontal.repeat(Math.max(1, width)));
}

export interface FooterStatus {
  model: string;
  repository: string;
  /** Cumulative tokens for the session; hidden at zero. */
  totalTokens: number;
  /** Right-hand goal badge, already formatted. */
  goal?: string;
}

/**
 * One dim line. The model and workspace sit left; the token counter and any
 * goal badge are right-aligned, and the path gives up columns first.
 */
export function renderStatus(status: FooterStatus, width: number): string[] {
  const badge = [
    status.goal ?? "",
    status.totalTokens > 0 ? `${formatTokens(status.totalTokens)} tokens` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // A narrow terminal keeps the model and workspace and drops the badge: the
  // badge is a reminder, the workspace is the thing you can act on being wrong.
  const right = visibleWidth(badge) + 24 <= width ? badge : "";
  const available = Math.max(4, width - 2 - (right ? visibleWidth(right) + 2 : 0));

  const prefix = `${status.model} · `;
  const path = truncate(
    status.repository,
    Math.max(1, available - visibleWidth(prefix)),
  );
  const left = `  ${tone.muted(truncate(`${prefix}${path}`, available))}`;

  if (!right) return [left];
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap < 1) return [left, alignRight(tone.muted(right), width)];
  return [`${left}${" ".repeat(gap)}${tone.muted(right)}`];
}

function alignRight(value: string, width: number): string {
  const clipped = truncate(value, width);
  return `${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}${clipped}`;
}
