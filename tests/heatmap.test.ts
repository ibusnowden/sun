import { describe, expect, test } from "bun:test";
import {
  clockDuration,
  isActivityMode,
  renderActivity,
} from "../src/tui/heatmap.ts";
import {
  emptyHistory,
  lifetimeStats,
  recordTask,
  recordUsage,
  type UsageHistory,
} from "../src/agent/usage.ts";
import { setColorEnabled, stripAnsi } from "../src/tui/theme.ts";

function at(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day, 12, 0, 0);
}

function usage(total: number) {
  return {
    promptTokens: total - 10,
    completionTokens: 10,
    totalTokens: total,
    contextTokens: 262_144,
  };
}

/** `days` back from `now`, each with the given token total. */
function history(now: Date, entries: Array<[number, number]>): UsageHistory {
  let result = emptyHistory();
  for (const [daysAgo, total] of entries) {
    const when = new Date(now);
    when.setDate(when.getDate() - daysAgo);
    result = recordUsage(result, usage(total), when);
  }
  return result;
}

const NOW = at(2026, 7, 29);

describe("activity grid", () => {
  test("draws seven weekday rows, a legend, and the mode switcher", () => {
    const text = stripAnsi(
      renderActivity(history(NOW, [[0, 5_000], [3, 9_000]]), "daily", 120, NOW).join("\n"),
    );
    expect(text).toContain("Token activity");
    expect(text).toContain("last 12 months");
    for (const label of ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]) {
      expect(text).toContain(` ${label} `);
    }
    expect(text).toContain("Less");
    expect(text).toContain("More");
    expect(text).toContain("daily · weekly · cumulative");
    // All twelve months are named, none dropped for spacing.
    for (const month of ["Aug", "Sep", "Dec", "Mar", "Jul"]) {
      expect(text).toContain(month);
    }
  });

  test("a day with nothing on it is hollow, an active day solid", () => {
    const text = stripAnsi(
      renderActivity(history(NOW, [[0, 5_000]]), "daily", 120, NOW).join("\n"),
    );
    expect(text).toContain("□");
    expect(text).toContain("■");
  });

  test("cells top out at the colour codex uses, and step down below it", () => {
    setColorEnabled(true);
    const spread = history(
      NOW,
      [[0, 1_000], [1, 20_000], [2, 400_000], [3, 9_000_000]],
    );
    const raw = renderActivity(spread, "daily", 120, NOW).join("\n");
    // Read off a live codex-cli 0.145.0 under a pty.
    expect(raw).toContain("\x1b[38;2;249;226;175m■");
    expect(raw).toContain("\x1b[38;2;122;112;87m■");
    // Labels and figures use codex's muted and accent colours.
    expect(raw).toContain("\x1b[38;2;147;153;178m");
    expect(raw).toContain("\x1b[38;2;250;179;135m");
    setColorEnabled(false);
  });

  test("the requested mode is the highlighted one", () => {
    setColorEnabled(true);
    const data = history(NOW, [[0, 5_000]]);
    for (const mode of ["daily", "weekly", "cumulative"] as const) {
      const raw = renderActivity(data, mode, 120, NOW).join("\n");
      expect(raw).toContain(`\x1b[38;2;250;179;135m${mode}`);
    }
    setColorEnabled(false);
  });

  test("weekly gives every day in a column the same value", () => {
    // One heavy day makes its whole column solid under weekly, but leaves the
    // rest of that column hollow under daily.
    const data = history(NOW, [[9, 900_000]]);
    const daily = stripAnsi(renderActivity(data, "daily", 120, NOW).join("\n"));
    const weekly = stripAnsi(renderActivity(data, "weekly", 120, NOW).join("\n"));
    // The legend carries four solid swatches of its own.
    const count = (text: string) => (text.match(/■/g) ?? []).length - 4;
    expect(count(daily)).toBe(1);
    expect(count(weekly)).toBe(7);
  });

  test("cumulative never decreases as the year runs on", () => {
    const data = history(NOW, [[30, 1_000], [20, 1_000], [10, 1_000]]);
    const text = stripAnsi(renderActivity(data, "cumulative", 120, NOW).join("\n"));
    // Every recorded day and everything after it is active under a running
    // total, so far more cells are filled than the three that were recorded.
    expect((text.match(/■/g) ?? []).length).toBeGreaterThan(20);
  });

  test("an empty history renders the frame without inventing activity", () => {
    const text = stripAnsi(
      renderActivity(emptyHistory(), "daily", 120, NOW).join("\n"),
    );
    expect(text).toContain("Nothing recorded yet.");
    // Only the legend's four swatches are solid; every grid cell is hollow.
    expect((text.match(/■/g) ?? []).length).toBe(4);
  });

  test("a narrow terminal says so instead of drawing a broken grid", () => {
    const text = stripAnsi(
      renderActivity(history(NOW, [[0, 5_000]]), "daily", 12, NOW).join("\n"),
    );
    expect(text).toContain("Too narrow");
    expect(text).not.toContain("Su");
  });

  test("a medium terminal keeps the most recent weeks and says how many", () => {
    const text = stripAnsi(
      renderActivity(history(NOW, [[0, 5_000]]), "daily", 60, NOW).join("\n"),
    );
    expect(text).toContain("Su ");
    expect(text).not.toContain("last 12 months");
    expect(text).toMatch(/last \d+ (weeks|months)/);
  });

  test("isActivityMode rejects anything that is not a view", () => {
    expect(isActivityMode("daily")).toBeTrue();
    expect(isActivityMode("cumulative")).toBeTrue();
    expect(isActivityMode("yearly")).toBeFalse();
  });
});

describe("lifetime statistics", () => {
  test("counts a streak that reaches yesterday as still running", () => {
    const data = history(NOW, [[1, 1_000], [2, 1_000], [3, 1_000]]);
    const stats = lifetimeStats(data, NOW);
    expect(stats.streakDays).toBe(3);
    expect(stats.bestStreakDays).toBe(3);
  });

  test("a two-day gap ends the streak but keeps the best", () => {
    const data = history(NOW, [[5, 1_000], [6, 1_000], [7, 1_000], [8, 1_000]]);
    const stats = lifetimeStats(data, NOW);
    expect(stats.streakDays).toBe(0);
    expect(stats.bestStreakDays).toBe(4);
  });

  test("reports the lifetime total and the heaviest single day", () => {
    const stats = lifetimeStats(
      history(NOW, [[0, 1_000], [1, 90_000], [40, 5_000]]),
      NOW,
    );
    expect(stats.lifetimeTokens).toBe(96_000);
    expect(stats.peakTokens).toBe(90_000);
    expect(stats.activeDays).toBe(3);
  });

  test("keeps the longest task, not the latest", () => {
    let data = recordTask(emptyHistory(), 42_660_000, NOW);
    data = recordTask(data, 1_000, NOW);
    expect(lifetimeStats(data, NOW).longestTaskMs).toBe(42_660_000);
    expect(clockDuration(42_660_000)).toBe("11h 51m");
  });

  test("clock durations read as codex writes them", () => {
    expect(clockDuration(4_000)).toBe("4s");
    expect(clockDuration(552_000)).toBe("9m 12s");
    expect(clockDuration(42_660_000)).toBe("11h 51m");
  });
});
