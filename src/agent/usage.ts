import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelUsage } from "../core/types.ts";

/**
 * Token spend that outlives one session.
 *
 * Stored as one bucket per local calendar day. A day is the smallest unit that
 * still answers "what have I spent this week", and keeping raw per-call rows
 * would grow without bound for no extra answer. Periods are calendar-based,
 * not rolling windows: "this week" means since Monday, and the rendered report
 * always names the start date so the number is never ambiguous.
 */

const FILE = "usage.json";
/** Days kept on disk. Beyond this the file is history nobody reads. */
const RETAIN_DAYS = 400;

export interface DailyUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Longest single task that finished on this day, in milliseconds. */
  longestTaskMs?: number;
}

export interface UsageHistory {
  /** Local `YYYY-MM-DD` → that day's totals. */
  days: Record<string, DailyUsage>;
}

export interface PeriodTotal extends DailyUsage {
  /** Local date the period opened, `YYYY-MM-DD`. */
  since: string;
  /** Days in the period that recorded anything. */
  activeDays: number;
}

export function emptyHistory(): UsageHistory {
  return { days: {} };
}

/** Local calendar day, not UTC: the user's "today" is the local one. */
export function dayKey(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

export function recordUsage(
  history: UsageHistory,
  usage: ModelUsage,
  when: Date = new Date(),
): UsageHistory {
  const key = dayKey(when);
  const day = history.days[key] ?? {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  return {
    days: {
      ...history.days,
      [key]: {
        calls: day.calls + 1,
        promptTokens: day.promptTokens + usage.promptTokens,
        completionTokens: day.completionTokens + usage.completionTokens,
        totalTokens: day.totalTokens + usage.totalTokens,
      },
    },
  };
}

/** Folds one finished task's wall time into its day, keeping the longest. */
export function recordTask(
  history: UsageHistory,
  durationMs: number,
  when: Date = new Date(),
): UsageHistory {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return history;
  const key = dayKey(when);
  const day = history.days[key] ?? {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  return {
    days: {
      ...history.days,
      [key]: {
        ...day,
        longestTaskMs: Math.max(day.longestTaskMs ?? 0, Math.round(durationMs)),
      },
    },
  };
}

export interface LifetimeStats {
  lifetimeTokens: number;
  /** Heaviest single day. */
  peakTokens: number;
  /** Consecutive active days ending today or yesterday. */
  streakDays: number;
  bestStreakDays: number;
  longestTaskMs: number;
  activeDays: number;
}

/**
 * A streak that ended yesterday is still running — the day is not over. Only a
 * gap of two days or more breaks it.
 */
export function lifetimeStats(
  history: UsageHistory,
  now: Date = new Date(),
): LifetimeStats {
  const active = Object.entries(history.days)
    .filter(
      ([, day]) =>
        day.totalTokens > 0 || day.calls > 0 || (day.longestTaskMs ?? 0) > 0,
    )
    .sort(([left], [right]) => (left < right ? -1 : 1));

  const stats: LifetimeStats = {
    lifetimeTokens: 0,
    peakTokens: 0,
    streakDays: 0,
    bestStreakDays: 0,
    longestTaskMs: 0,
    activeDays: active.length,
  };

  let run = 0;
  let previous: string | null = null;
  for (const [key, day] of active) {
    stats.lifetimeTokens += day.totalTokens;
    stats.peakTokens = Math.max(stats.peakTokens, day.totalTokens);
    stats.longestTaskMs = Math.max(stats.longestTaskMs, day.longestTaskMs ?? 0);
    run = previous && daysBetween(previous, key) === 1 ? run + 1 : 1;
    stats.bestStreakDays = Math.max(stats.bestStreakDays, run);
    previous = key;
  }

  if (previous) {
    const gap = daysBetween(previous, dayKey(now));
    stats.streakDays = gap <= 1 ? run : 0;
  }
  return stats;
}

const MS_PER_DAY = 86_400_000;

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / MS_PER_DAY);
}

/** Parses a `YYYY-MM-DD` key back into a local midnight Date. */
export function parseDay(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

/** Monday of the week containing `when`, in local time. */
export function startOfWeek(when: Date): Date {
  const start = new Date(when.getFullYear(), when.getMonth(), when.getDate());
  // getDay() is 0 for Sunday, which belongs to the week that began 6 days ago.
  const offset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - offset);
  return start;
}

export function startOfMonth(when: Date): Date {
  return new Date(when.getFullYear(), when.getMonth(), 1);
}

export function summarize(
  history: UsageHistory,
  when: Date = new Date(),
): { week: PeriodTotal; month: PeriodTotal } {
  return {
    week: totalSince(history, startOfWeek(when), when),
    month: totalSince(history, startOfMonth(when), when),
  };
}

function totalSince(
  history: UsageHistory,
  from: Date,
  to: Date,
): PeriodTotal {
  const since = dayKey(from);
  const until = dayKey(to);
  const total: PeriodTotal = {
    since,
    activeDays: 0,
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  // Keys are zero-padded ISO dates, so string comparison is date comparison.
  for (const [key, day] of Object.entries(history.days)) {
    if (key < since || key > until) continue;
    total.activeDays += 1;
    total.calls += day.calls;
    total.promptTokens += day.promptTokens;
    total.completionTokens += day.completionTokens;
    total.totalTokens += day.totalTokens;
  }
  return total;
}

export async function loadHistory(
  agentDirectory: string,
): Promise<UsageHistory> {
  const raw = await readFile(join(agentDirectory, FILE), "utf8").catch(
    () => null,
  );
  if (!raw) return emptyHistory();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyHistory();
    const days = (parsed as { days?: unknown }).days;
    if (!days || typeof days !== "object") return emptyHistory();
    const clean: Record<string, DailyUsage> = {};
    for (const [key, value] of Object.entries(days as object)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      const day = asDaily(value);
      if (day) clean[key] = day;
    }
    return { days: clean };
  } catch {
    // A corrupt ledger must never take the session down with it.
    return emptyHistory();
  }
}

export async function saveHistory(
  agentDirectory: string,
  history: UsageHistory,
  when: Date = new Date(),
): Promise<void> {
  const cutoff = new Date(when);
  cutoff.setDate(cutoff.getDate() - RETAIN_DAYS);
  const floor = dayKey(cutoff);
  const days = Object.fromEntries(
    Object.entries(history.days).filter(([key]) => key >= floor).sort(),
  );
  await writeFile(
    join(agentDirectory, FILE),
    `${JSON.stringify({ days }, null, 2)}\n`,
  );
}

function asDaily(value: unknown): DailyUsage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const number = (key: string): number =>
    typeof record[key] === "number" && Number.isFinite(record[key])
      ? Math.max(0, record[key])
      : 0;
  const longestTaskMs = number("longestTaskMs");
  const day: DailyUsage = {
    calls: number("calls"),
    promptTokens: number("promptTokens"),
    completionTokens: number("completionTokens"),
    totalTokens: number("totalTokens"),
    ...(longestTaskMs > 0 ? { longestTaskMs } : {}),
  };
  return day.calls === 0 && day.totalTokens === 0 && longestTaskMs === 0
    ? null
    : day;
}
