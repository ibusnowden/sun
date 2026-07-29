import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runTrustedProcess } from "./core/process.ts";
import { PACKAGE_NAME, VERSION } from "./version.ts";

/**
 * Staying current, without ever getting in the way.
 *
 * Two rules shape everything here. First, an update check is never allowed to
 * fail a run: the registry being unreachable, rate-limiting, or not yet
 * carrying this package are all normal conditions on someone else's machine,
 * and none of them are a reason for `sun` to refuse to start. Every failure
 * path in this file resolves to `null`. Second, the check is cached on disk
 * for a day, because asking a registry on every launch would make an HTTP
 * round trip a prerequisite for a local tool.
 */

const REGISTRY = "https://registry.npmjs.org";
const CHECK_TIMEOUT_MS = 1_200;
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const INSTALL_TIMEOUT_MS = 180_000;
const MAX_INSTALL_OUTPUT_BYTES = 64 * 1024;

export interface UpdateStatus {
  current: string;
  latest: string;
  outdated: boolean;
}

interface CacheEntry {
  checkedAt: number;
  latest: string;
}

export interface CheckOptions {
  packageName?: string;
  currentVersion?: string;
  registry?: string;
  timeoutMs?: number;
  ttlMs?: number;
  now?: number;
  cacheFile?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Skip the cache and ask the registry. Used by an explicit `sun update`. */
  force?: boolean;
}

/**
 * Where the "when did we last look" record lives.
 *
 * Deliberately user-global rather than under the workspace's `.agent/`: the
 * install being checked is global, so a per-repository cache would re-ask the
 * registry once per project and leave a stray file in every repository Sun
 * ever touched.
 */
export function cachePath(environment: Record<string, string | undefined> = process.env): string {
  const base = environment.XDG_CACHE_HOME?.trim();
  return join(base && base.length > 0 ? base : join(homedir(), ".cache"), "sun", "update.json");
}

/**
 * Compares two semantic versions. Returns a negative number when `left` is
 * older, zero when they match, positive when `left` is newer.
 *
 * A plain string comparison gets this wrong in the ordinary case ("0.10.0" <
 * "0.9.0" lexically), and a release must never be hidden by its own version
 * number, so the parts are compared numerically. A prerelease sorts before the
 * release it leads to, per semver, which keeps `1.0.0-rc.1` from advertising
 * itself as newer than `1.0.0`.
 */
export function compareVersions(left: string, right: string): number {
  const parse = (
    value: string,
  ): { core: number[]; prerelease: string[] } => {
    const [core = "", prerelease = ""] = value.trim().replace(/^v/, "").split("-", 2);
    return {
      core: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
      prerelease: prerelease.length > 0 ? prerelease.split(".") : [],
    };
  };

  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }

  // Having a prerelease tag makes a version older than the same core without
  // one: 1.0.0-rc.1 precedes 1.0.0.
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left_ = a.prerelease[index];
    const right_ = b.prerelease[index];
    if (left_ === undefined) return -1;
    if (right_ === undefined) return 1;
    if (left_ === right_) continue;
    const leftNumber = Number.parseInt(left_, 10);
    const rightNumber = Number.parseInt(right_, 10);
    const bothNumeric = /^\d+$/.test(left_) && /^\d+$/.test(right_);
    if (bothNumeric) return leftNumber < rightNumber ? -1 : 1;
    return left_ < right_ ? -1 : 1;
  }
  return 0;
}

/** The registry path for a package, with the scope separator escaped. */
function registryUrl(registry: string, packageName: string): string {
  const encoded = packageName.startsWith("@")
    ? packageName.replace("/", "%2F")
    : encodeURIComponent(packageName);
  return `${registry.replace(/\/+$/, "")}/${encoded}/latest`;
}

async function readCache(file: string): Promise<CacheEntry | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const entry = parsed as Partial<CacheEntry>;
    if (typeof entry.latest !== "string" || typeof entry.checkedAt !== "number") {
      return null;
    }
    return { checkedAt: entry.checkedAt, latest: entry.latest };
  } catch {
    return null;
  }
}

async function writeCache(file: string, entry: CacheEntry): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(entry, null, 2)}\n`);
  } catch {
    // A cache that cannot be written costs one HTTP request per launch. That
    // is not worth failing a run over, so a read-only cache directory is
    // silently tolerated.
  }
}

/**
 * Asks the registry for the published version. Resolves to `null` for every
 * failure, including the one that is true right up until the first publish:
 * the package does not exist yet, and a 404 must not read as an error.
 */
export async function fetchLatestVersion(options: CheckOptions = {}): Promise<string | null> {
  const request = options.fetchImpl ?? fetch;
  const url = registryUrl(options.registry ?? REGISTRY, options.packageName ?? PACKAGE_NAME);
  try {
    const response = await request(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? CHECK_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const version = (body as { version?: unknown } | null)?.version;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

/**
 * The cached daily check. Returns `null` when nothing is known — never throws,
 * so callers can await it on the startup path without a try/catch.
 */
export async function checkForUpdate(options: CheckOptions = {}): Promise<UpdateStatus | null> {
  const current = options.currentVersion ?? VERSION;
  const file = options.cacheFile ?? cachePath();
  const now = options.now ?? Date.now();
  const ttl = options.ttlMs ?? CACHE_TTL_MS;

  const cached = await readCache(file);
  if (!options.force && cached && now - cached.checkedAt < ttl) {
    return status(current, cached.latest);
  }

  const latest = await fetchLatestVersion(options);
  if (latest === null) {
    // Fall back to whatever was last seen rather than reporting nothing: a
    // known-stale answer still beats silence when the network is down.
    return cached ? status(current, cached.latest) : null;
  }
  await writeCache(file, { checkedAt: now, latest });
  return status(current, latest);
}

function status(current: string, latest: string): UpdateStatus {
  return { current, latest, outdated: compareVersions(current, latest) < 0 };
}

/** The one-line banner shown under the session header. */
export function updateNotice(update: UpdateStatus | null, packageName = PACKAGE_NAME): string | null {
  if (!update?.outdated) return null;
  return `Update available: ${update.current} → ${update.latest}. Run \`sun update\` (or \`bun install -g ${packageName}@latest\`).`;
}

export interface InstallOptions {
  packageName?: string;
  /** Directory of this module; used to detect a linked source checkout. */
  moduleDir?: string;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * A `bun link`ed checkout is not an installed package: `bun install -g` would
 * either fail or, worse, quietly shadow the developer's working tree with a
 * registry copy and make their edits stop taking effect. Detected by finding a
 * `.git` directory beside a package.json that names this same package.
 */
export async function isSourceCheckout(moduleDir: string): Promise<boolean> {
  const root = dirname(moduleDir);
  try {
    const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if ((manifest as { name?: unknown } | null)?.name !== PACKAGE_NAME) return false;
    await stat(join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

export interface InstallResult {
  ok: boolean;
  message: string;
}

/**
 * Performs the upgrade by delegating to Bun, which owns the global install
 * directory. Sun does not try to move its own files around: whatever installed
 * it is the thing that knows how to replace it.
 */
export async function installLatest(options: InstallOptions = {}): Promise<InstallResult> {
  const packageName = options.packageName ?? PACKAGE_NAME;
  const moduleDir = options.moduleDir ?? import.meta.dir;

  if (await isSourceCheckout(moduleDir)) {
    return {
      ok: false,
      message: `This Sun is a linked source checkout at ${dirname(moduleDir)}, not an installed package. Update it with \`git pull\` there instead.`,
    };
  }

  let result;
  try {
    result = await runTrustedProcess(["bun", "install", "-g", `${packageName}@latest`], {
      cwd: options.cwd ?? process.cwd(),
      timeoutMs: options.timeoutMs ?? INSTALL_TIMEOUT_MS,
      maxOutputBytes: MAX_INSTALL_OUTPUT_BYTES,
    });
  } catch (error) {
    // Bun.spawn throws rather than exiting non-zero when the binary is not on
    // PATH, which is exactly the case worth naming precisely.
    return {
      ok: false,
      message: `Could not run bun: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (result.timedOut) {
    return { ok: false, message: "Timed out installing the update." };
  }
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    return {
      ok: false,
      message: detail.length > 0 ? detail : `bun install exited with ${result.exitCode}`,
    };
  }
  return { ok: true, message: (result.stdout || result.stderr).trim() };
}
