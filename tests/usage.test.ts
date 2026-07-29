import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  dayKey,
  emptyHistory,
  loadHistory,
  recordUsage,
  saveHistory,
  startOfMonth,
  startOfWeek,
  summarize,
  type UsageHistory,
} from "../src/agent/usage.ts";
import { temporaryDirectory } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function usage(total: number) {
  return {
    promptTokens: total - 100,
    completionTokens: 100,
    totalTokens: total,
    contextTokens: 262_144,
  };
}

/** Local noon, so a timezone offset can never shift the calendar day. */
function at(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day, 12, 0, 0);
}

describe("calendar boundaries", () => {
  test("a week begins on Monday, and Sunday belongs to the week before it", () => {
    // 2026-07-29 is a Wednesday.
    expect(dayKey(startOfWeek(at(2026, 7, 29)))).toBe("2026-07-27");
    // Monday is its own start.
    expect(dayKey(startOfWeek(at(2026, 7, 27)))).toBe("2026-07-27");
    // Sunday closes that week rather than opening a new one.
    expect(dayKey(startOfWeek(at(2026, 8, 2)))).toBe("2026-07-27");
    // The following Monday does open one.
    expect(dayKey(startOfWeek(at(2026, 8, 3)))).toBe("2026-08-03");
  });

  test("a month begins on the first", () => {
    expect(dayKey(startOfMonth(at(2026, 7, 29)))).toBe("2026-07-01");
    expect(dayKey(startOfMonth(at(2026, 1, 1)))).toBe("2026-01-01");
  });
});

describe("summaries", () => {
  test("counts only the days inside each period", () => {
    let history = emptyHistory();
    // Last month, before the week, inside the week, and today.
    history = recordUsage(history, usage(1_000), at(2026, 6, 15));
    history = recordUsage(history, usage(2_000), at(2026, 7, 20));
    history = recordUsage(history, usage(4_000), at(2026, 7, 27));
    history = recordUsage(history, usage(8_000), at(2026, 7, 29));

    const { week, month } = summarize(history, at(2026, 7, 29));

    expect(week).toMatchObject({
      since: "2026-07-27",
      activeDays: 2,
      calls: 2,
      totalTokens: 12_000,
    });
    expect(month).toMatchObject({
      since: "2026-07-01",
      activeDays: 3,
      calls: 3,
      totalTokens: 14_000,
    });
  });

  test("a future day is not counted into today's totals", () => {
    let history = recordUsage(emptyHistory(), usage(5_000), at(2026, 7, 29));
    history = recordUsage(history, usage(9_000), at(2026, 7, 31));
    expect(summarize(history, at(2026, 7, 29)).week.totalTokens).toBe(5_000);
  });

  test("several calls on one day fold into one bucket", () => {
    let history = emptyHistory();
    for (let index = 0; index < 4; index += 1) {
      history = recordUsage(history, usage(1_000), at(2026, 7, 29));
    }
    expect(Object.keys(history.days)).toEqual(["2026-07-29"]);
    expect(summarize(history, at(2026, 7, 29)).week).toMatchObject({
      activeDays: 1,
      calls: 4,
      totalTokens: 4_000,
    });
  });

  test("an empty history summarizes to zero rather than failing", () => {
    const { week, month } = summarize(emptyHistory(), at(2026, 7, 29));
    expect(week.calls).toBe(0);
    expect(month.totalTokens).toBe(0);
  });
});

describe("persistence", () => {
  test("survives a round trip and prunes what is too old to read", async () => {
    const temporary = await temporaryDirectory();
    cleanups.push(temporary.cleanup);
    let history = recordUsage(emptyHistory(), usage(3_000), at(2026, 7, 29));
    history = recordUsage(history, usage(7_000), at(2024, 1, 5));

    await saveHistory(temporary.path, history, at(2026, 7, 29));
    const loaded = await loadHistory(temporary.path);

    expect(loaded.days["2026-07-29"]).toMatchObject({
      calls: 1,
      totalTokens: 3_000,
    });
    expect(loaded.days["2024-01-05"]).toBeUndefined();
  });

  test("a missing or corrupt ledger yields an empty history, not a crash", async () => {
    const temporary = await temporaryDirectory();
    cleanups.push(temporary.cleanup);
    expect(await loadHistory(temporary.path)).toEqual(emptyHistory());

    await writeFile(join(temporary.path, "usage.json"), "{not json at all");
    expect(await loadHistory(temporary.path)).toEqual(emptyHistory());

    await writeFile(
      join(temporary.path, "usage.json"),
      JSON.stringify({ days: { "not-a-date": { calls: 5 }, "2026-07-29": 7 } }),
    );
    expect(await loadHistory(temporary.path)).toEqual(emptyHistory());
  });

  test("writes sorted, human-readable JSON", async () => {
    const temporary = await temporaryDirectory();
    cleanups.push(temporary.cleanup);
    let history: UsageHistory = emptyHistory();
    history = recordUsage(history, usage(1_000), at(2026, 7, 29));
    history = recordUsage(history, usage(1_000), at(2026, 7, 27));

    await saveHistory(temporary.path, history, at(2026, 7, 29));
    const raw = await readFile(join(temporary.path, "usage.json"), "utf8");

    expect(raw.indexOf("2026-07-27")).toBeLessThan(raw.indexOf("2026-07-29"));
    expect(raw.endsWith("\n")).toBeTrue();
  });
});
