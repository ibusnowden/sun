import {
  dayKey,
  daysBetween,
  lifetimeStats,
  parseDay,
  type UsageHistory,
} from "../agent/usage.ts";
import {
  formatTokens,
  paintRgb,
  tone,
  truncate,
  visibleWidth,
} from "./theme.ts";

/**
 * A year of token activity as a contributions grid.
 *
 * Layout, glyphs, and colours were read off a live `codex-cli 0.145.0` under a
 * pty rather than guessed: `□` dim for a day with nothing on it, `■` bold in
 * 24-bit `rgb(249,226,175)` for an active one, muted `rgb(147,153,178)` for
 * every label, and `rgb(250,179,135)` for the figures in the stat line.
 *
 * One deliberate difference: Codex 0.145.0 renders cells as a binary on/off,
 * even though its own legend promises "Less → More". Sun gives the legend its
 * meaning with four intensity steps, the brightest of which is Codex's exact
 * colour — so a saturated grid looks identical and a mixed one says more.
 */

export type ActivityMode = "daily" | "weekly" | "cumulative";

export const ACTIVITY_MODES: readonly ActivityMode[] = [
  "daily",
  "weekly",
  "cumulative",
];

export function isActivityMode(value: string): value is ActivityMode {
  return (ACTIVITY_MODES as readonly string[]).includes(value);
}

/**
 * Everything `/usage` can show. `session` is not a grid — it is this session's
 * ledger and per-tool cost — but it belongs in the same footer as the three
 * grid modes, because from the user's side they are four views of one
 * question and the footer is the only place they are advertised.
 */
export type UsageView = "session" | ActivityMode;

export const USAGE_VIEWS: readonly UsageView[] = ["session", ...ACTIVITY_MODES];

export function isUsageView(value: string): value is UsageView {
  return (USAGE_VIEWS as readonly string[]).includes(value);
}

/** The `session · daily · weekly · cumulative` row, current view highlighted. */
export function usageFooter(active: UsageView): string {
  return `   ${modeRow(active)}`;
}

const MUTED = [147, 153, 178] as const;
const FIGURE = [250, 179, 135] as const;
/** Level 4 is Codex's cell colour; the rest step down toward the background. */
const RAMP = [
  [122, 112, 87],
  [168, 153, 116],
  [209, 190, 146],
  [249, 226, 175],
] as const;

const WEEKS = 53;
const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;
/** ` Su ` — one space, two letters, one space. */
const GUTTER = 4;
/** Below this many columns the grid says nothing worth the rows it costs. */
const MIN_COLUMNS = 6;

export function renderActivity(
  history: UsageHistory,
  mode: ActivityMode,
  width: number,
  now: Date = new Date(),
): string[] {
  const columns = Math.min(WEEKS, Math.floor((width - GUTTER) / 2));
  if (columns < MIN_COLUMNS) {
    const room = Math.max(1, width - 1);
    return [
      "",
      ` ${tone.heading(truncate("Token activity", room))}`,
      // Short enough to survive truncation at the widths that trigger it.
      ` ${muted(truncate("Too narrow for the activity grid.", room))}`,
      "",
    ];
  }

  const grid = buildGrid(history, mode, columns, now);
  const stats = lifetimeStats(history, now);
  const levels = quantize(grid.values);

  const lines = [
    "",
    ` ${tone.heading("Token activity")}   ${muted(`last ${describeSpan(columns)}`)}`,
    ` ${truncate(statLine(stats), Math.max(4, width - 1))}`,
    "",
    `${" ".repeat(GUTTER)}${monthRow(grid.starts, width)}`,
  ];

  for (const [row, label] of DAY_LABELS.entries()) {
    const cells = grid.starts.map((_, column) => {
      const value = grid.values[column * 7 + row];
      return value === null || value === undefined ? " " : cell(levels(value));
    });
    lines.push(` ${muted(label)} ${cells.join(" ")}`);
  }

  lines.push(
    "",
    `   ${muted("Less")} ${cell(0)} ${cell(1)} ${cell(2)} ${cell(3)} ${cell(4)} ${muted("More")}`,
    usageFooter(mode),
    "",
  );
  return lines;
}

function muted(value: string): string {
  return paintRgb(value, MUTED);
}

function figure(value: string): string {
  return paintRgb(value, FIGURE);
}

/** `□` for nothing, `■` at one of four brightnesses. */
function cell(level: number): string {
  if (level <= 0) return tone.muted("□");
  return paintRgb("■", RAMP[Math.min(3, level - 1)] ?? RAMP[3], "bold");
}

function statLine(stats: ReturnType<typeof lifetimeStats>): string {
  if (stats.activeDays === 0) {
    return muted("Nothing recorded yet.");
  }
  const parts: string[] = [
    `${muted("Lifetime ")}${figure(formatTokens(stats.lifetimeTokens))}`,
    `${muted("Peak ")}${figure(formatTokens(stats.peakTokens))}`,
    `${muted("Streak ")}${figure(`${stats.streakDays}d (best ${stats.bestStreakDays}d)`)}`,
  ];
  if (stats.longestTaskMs > 0) {
    parts.push(
      `${muted("Longest task ")}${figure(clockDuration(stats.longestTaskMs))}`,
    );
  }
  return parts.join(muted(" · "));
}

/** `11h 51m`, `9m 12s`, `4s` — the longest two units that carry meaning. */
export function clockDuration(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function describeSpan(columns: number): string {
  if (columns >= WEEKS - 1) return "12 months";
  const months = Math.round((columns * 7) / 30.44);
  return months >= 2 ? `${months} months` : `${columns} weeks`;
}

/**
 * Column values in row-major order per column: index `column * 7 + weekday`.
 * `null` means the cell falls outside the recorded span, so it draws blank
 * rather than as a day with nothing on it.
 */
function buildGrid(
  history: UsageHistory,
  mode: ActivityMode,
  columns: number,
  now: Date,
): { starts: Date[]; values: Array<number | null> } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // The last column is the week holding today; Sunday opens each column.
  const lastStart = new Date(today);
  lastStart.setDate(lastStart.getDate() - today.getDay());
  const starts: Date[] = [];
  for (let index = columns - 1; index >= 0; index -= 1) {
    const start = new Date(lastStart);
    start.setDate(start.getDate() - index * 7);
    starts.push(start);
  }

  const daily: Array<number | null> = [];
  for (const start of starts) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = new Date(start);
      date.setDate(date.getDate() + weekday);
      daily.push(date > today ? null : (history.days[dayKey(date)]?.totalTokens ?? 0));
    }
  }

  if (mode === "daily") return { starts, values: daily };

  if (mode === "weekly") {
    // Every day in a column reports that column's total, so the grid reads as
    // bars rather than speckle.
    const values = daily.map((value, index) => {
      if (value === null) return null;
      const column = Math.floor(index / 7);
      let total = 0;
      for (let offset = 0; offset < 7; offset += 1) {
        total += daily[column * 7 + offset] ?? 0;
      }
      return total;
    });
    return { starts, values };
  }

  let running = 0;
  const values = daily.map((value) => {
    if (value === null) return null;
    running += value;
    return running;
  });
  return { starts, values };
}

/**
 * Quartiles of the distinct non-zero values, so one enormous day cannot flatten
 * everything else into the lowest step.
 */
function quantize(values: Array<number | null>): (value: number) => number {
  const active = [...new Set(values.filter((v): v is number => v !== null && v > 0))].sort(
    (left, right) => left - right,
  );
  if (active.length === 0) return () => 0;
  const cuts = [0.25, 0.5, 0.75].map(
    (fraction) => active[Math.floor((active.length - 1) * fraction)] ?? 0,
  );
  return (value: number): number => {
    if (value <= 0) return 0;
    if (value <= (cuts[0] ?? 0)) return 1;
    if (value <= (cuts[1] ?? 0)) return 2;
    if (value <= (cuts[2] ?? 0)) return 3;
    return 4;
  };
}

/**
 * A month name sits over the column where that month starts. The grid opens
 * mid-month, and that leading stub is left unlabelled: naming it would put the
 * same month at both ends of a 12-month row.
 */
function monthRow(starts: Date[], width: number): string {
  let row = "";
  for (const [column, start] of starts.entries()) {
    if (column === 0) continue;
    const previous = starts[column - 1];
    if (!previous || previous.getMonth() === start.getMonth()) continue;
    const label = MONTH_LABELS[start.getMonth()] ?? "";
    const at = column * 2;
    // One space of clearance keeps two labels from running together.
    if (visibleWidth(row) + 1 > at) continue;
    row = `${row}${" ".repeat(at - visibleWidth(row))}${label}`;
  }
  return muted(truncate(row, Math.max(1, width - GUTTER)));
}

function modeRow(active: UsageView): string {
  return USAGE_VIEWS.map((mode) =>
    mode === active ? paintRgb(mode, FIGURE, "bold") : muted(mode),
  ).join(muted(" · "));
}
