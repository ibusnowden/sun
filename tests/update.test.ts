import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cachePath,
  checkForUpdate,
  compareVersions,
  fetchLatestVersion,
  installLatest,
  isSourceCheckout,
  updateNotice,
} from "../src/update.ts";
import { PACKAGE_NAME, VERSION } from "../src/version.ts";
import { temporaryDirectory } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function scratch(): Promise<string> {
  const directory = await temporaryDirectory("sun-update-");
  cleanups.push(directory.cleanup);
  return directory.path;
}

/** A `fetch` that answers with one registry document and counts its calls. */
function registry(version: string | null, status = 200) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    if (version === null) {
      return new Response("not found", { status });
    }
    return new Response(JSON.stringify({ version }), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("compareVersions", () => {
  test("orders release numbers numerically, not lexically", () => {
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });

  test("sorts a prerelease before the release it leads to", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
  });

  test("treats missing and unparsable parts as zero rather than throwing", () => {
    expect(compareVersions("1", "1.0.0")).toBe(0);
    expect(compareVersions("1.x.0", "1.0.0")).toBe(0);
  });
});

describe("fetchLatestVersion", () => {
  test("escapes the scope separator so the registry path stays valid", async () => {
    const feed = registry("9.9.9");
    await fetchLatestVersion({
      packageName: "@scope/tool",
      registry: "https://example.test",
      fetchImpl: feed.impl,
    });
    expect(feed.calls[0]).toBe("https://example.test/@scope%2Ftool/latest");
  });

  test("returns null for an unpublished package instead of throwing", async () => {
    const feed = registry(null, 404);
    expect(
      await fetchLatestVersion({ fetchImpl: feed.impl, registry: "https://example.test" }),
    ).toBeNull();
  });

  test("returns null when the network fails", async () => {
    const impl = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ fetchImpl: impl })).toBeNull();
  });
});

describe("checkForUpdate", () => {
  test("reports an available update and records it in the cache", async () => {
    const cacheFile = join(await scratch(), "update.json");
    const feed = registry("1.4.0");
    const update = await checkForUpdate({
      currentVersion: "1.3.0",
      cacheFile,
      fetchImpl: feed.impl,
      now: 1_000,
    });

    expect(update).toEqual({ current: "1.3.0", latest: "1.4.0", outdated: true });
    const cached: unknown = JSON.parse(await readFile(cacheFile, "utf8"));
    expect(cached).toEqual({ checkedAt: 1_000, latest: "1.4.0" });
  });

  test("serves a fresh cache without touching the network", async () => {
    const cacheFile = join(await scratch(), "update.json");
    await writeFile(cacheFile, JSON.stringify({ checkedAt: 1_000, latest: "2.0.0" }));
    const feed = registry("3.0.0");

    const update = await checkForUpdate({
      currentVersion: "1.0.0",
      cacheFile,
      fetchImpl: feed.impl,
      now: 1_000 + 60_000,
      ttlMs: 24 * 60 * 60 * 1_000,
    });

    expect(update?.latest).toBe("2.0.0");
    expect(feed.calls).toHaveLength(0);
  });

  test("re-asks once the cache has expired", async () => {
    const cacheFile = join(await scratch(), "update.json");
    await writeFile(cacheFile, JSON.stringify({ checkedAt: 0, latest: "2.0.0" }));
    const feed = registry("3.0.0");

    const update = await checkForUpdate({
      currentVersion: "1.0.0",
      cacheFile,
      fetchImpl: feed.impl,
      now: 25 * 60 * 60 * 1_000,
    });

    expect(update?.latest).toBe("3.0.0");
    expect(feed.calls).toHaveLength(1);
  });

  test("force ignores a fresh cache", async () => {
    const cacheFile = join(await scratch(), "update.json");
    await writeFile(cacheFile, JSON.stringify({ checkedAt: 1_000, latest: "2.0.0" }));
    const feed = registry("3.0.0");

    const update = await checkForUpdate({
      currentVersion: "1.0.0",
      cacheFile,
      fetchImpl: feed.impl,
      now: 1_100,
      force: true,
    });

    expect(update?.latest).toBe("3.0.0");
    expect(feed.calls).toHaveLength(1);
  });

  test("falls back to the last known answer when the registry is unreachable", async () => {
    const cacheFile = join(await scratch(), "update.json");
    await writeFile(cacheFile, JSON.stringify({ checkedAt: 0, latest: "2.0.0" }));
    const impl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const update = await checkForUpdate({
      currentVersion: "1.0.0",
      cacheFile,
      fetchImpl: impl,
      now: 25 * 60 * 60 * 1_000,
    });
    expect(update).toEqual({ current: "1.0.0", latest: "2.0.0", outdated: true });
  });

  test("resolves to null — never throws — with no cache and no network", async () => {
    const impl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const update = await checkForUpdate({
      cacheFile: join(await scratch(), "missing.json"),
      fetchImpl: impl,
    });
    expect(update).toBeNull();
  });

  test("survives a corrupt cache file", async () => {
    const cacheFile = join(await scratch(), "update.json");
    await writeFile(cacheFile, "{ not json");
    const feed = registry("3.0.0");

    const update = await checkForUpdate({
      currentVersion: "1.0.0",
      cacheFile,
      fetchImpl: feed.impl,
    });
    expect(update?.latest).toBe("3.0.0");
  });

  test("an unwritable cache directory does not fail the check", async () => {
    const feed = registry("3.0.0");
    const update = await checkForUpdate({
      currentVersion: "1.0.0",
      // A path under a regular file can never be created.
      cacheFile: join(import.meta.path, "nested", "update.json"),
      fetchImpl: feed.impl,
    });
    expect(update?.latest).toBe("3.0.0");
  });
});

describe("cachePath", () => {
  test("honours XDG_CACHE_HOME", () => {
    expect(cachePath({ XDG_CACHE_HOME: "/x/cache" })).toBe("/x/cache/sun/update.json");
  });

  test("falls back to ~/.cache when XDG_CACHE_HOME is unset or blank", () => {
    expect(cachePath({})).toMatch(/\.cache\/sun\/update\.json$/);
    expect(cachePath({ XDG_CACHE_HOME: "   " })).toMatch(/\.cache\/sun\/update\.json$/);
  });
});

describe("updateNotice", () => {
  test("names both versions and the command that fixes it", () => {
    const notice = updateNotice({ current: "1.0.0", latest: "1.1.0", outdated: true });
    expect(notice).toContain("1.0.0 → 1.1.0");
    expect(notice).toContain("sun update");
  });

  test("stays silent when current or unknown", () => {
    expect(updateNotice({ current: "1.1.0", latest: "1.1.0", outdated: false })).toBeNull();
    expect(updateNotice(null)).toBeNull();
  });
});

describe("installLatest", () => {
  test("refuses to overwrite a linked source checkout", async () => {
    const root = await scratch();
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: PACKAGE_NAME }));

    expect(await isSourceCheckout(join(root, "src"))).toBe(true);
    const result = await installLatest({ moduleDir: join(root, "src") });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("git pull");
  });

  test("does not mistake an unrelated git repository for a Sun checkout", async () => {
    const root = await scratch();
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "something-else" }));
    expect(await isSourceCheckout(join(root, "src"))).toBe(false);
  });

  test("an installed package with no .git beside it is not a checkout", async () => {
    const root = await scratch();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: PACKAGE_NAME }));
    expect(await isSourceCheckout(join(root, "src"))).toBe(false);
  });
});

describe("version", () => {
  test("is read from the manifest, so it can never drift from it", async () => {
    const manifest: unknown = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(VERSION).toBe((manifest as { version: string }).version);
    expect(PACKAGE_NAME).toBe((manifest as { name: string }).name);
  });
});
