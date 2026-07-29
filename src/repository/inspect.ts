import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "../core/process.ts";
import type {
  RepositoryObservation,
  SunConfig,
} from "../core/types.ts";

export async function observeRepository(
  config: SunConfig,
): Promise<RepositoryObservation> {
  if (config.workspaceMode) {
    const [projects, files] = await Promise.all([
      listWorkspaceProjects(config.repository),
      listWorkspaceFiles(config.repository, 20_000),
    ]);
    return {
      root: config.repository,
      gitStatus:
        "Workspace mode: nested projects are accessible.",
      files: [...projects.map((path) => `${path}/`), ...files].slice(0, 2_000),
    };
  }
  const [status, files] = await Promise.all([
    git(config, ["status", "--short", "--branch"]),
    git(config, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".",
      ":(exclude).agent",
    ]),
  ]);
  return {
    root: config.repository,
    gitStatus: (status.stdout || status.stderr).trim(),
    files: files.stdout.split("\0").filter(Boolean).slice(0, 2_000),
  };
}

export async function assertGitRepository(repository: string): Promise<string> {
  const result = await runProcess(
    ["git", "-C", repository, "rev-parse", "--show-toplevel"],
    {
      cwd: repository,
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
    },
  ).catch(() => null);
  if (!result || result.exitCode !== 0) {
    throw new Error(
      `${repository} is not inside a Git repository. Change to the repository directory, pass --repo /absolute/path/to/repository, or run bare "sun" there to open it as a workspace.`,
    );
  }
  return result.stdout.trim();
}

export async function isGitRepository(repository: string): Promise<boolean> {
  const result = await runProcess(
    ["git", "-C", repository, "rev-parse", "--is-inside-work-tree"],
    {
      cwd: repository,
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
    },
  ).catch(() => null);
  return result?.exitCode === 0 && result.stdout.trim() === "true";
}

export async function assertWorkspaceDirectory(directory: string): Promise<void> {
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`${directory} is not an accessible workspace directory.`);
  }
}

export interface RepositoryBaseline {
  fingerprints: Record<string, string>;
  workspaceMode?: boolean;
}

export async function captureRepositoryBaseline(
  config: SunConfig,
): Promise<RepositoryBaseline> {
  if (config.workspaceMode) {
    return {
      fingerprints: await workspaceFingerprints(config.repository),
      workspaceMode: true,
    };
  }
  const { status } = await repositoryStatus(config);
  return {
    fingerprints: await fingerprints(config, status),
  };
}

export async function repositoryChanges(
  config: SunConfig,
  baseline?: RepositoryBaseline,
): Promise<{
  files: string[];
  diff: string;
  /** Set when Git could not read the workspace at all, rather than finding it clean. */
  unreadable?: string;
}> {
  if (config.workspaceMode) {
    const current = await workspaceFingerprints(config.repository);
    const files = baseline
      ? changedSinceBaseline(baseline.fingerprints, current)
      : [];
    return {
      files,
      diff: files.length
        ? [
            "Workspace changes (the workspace root is not a Git repository):",
            ...files.map((path) => `${current[path] ? "M" : "D"} ${path}`),
          ].join("\n")
        : "",
    };
  }
  const { status, error } = await repositoryStatus(config);
  // "Git failed" and "nothing changed" both produce an empty status. Telling
  // them apart matters most for a workspace nested inside a larger repository:
  // the sandbox binds only the workspace, so Git cannot reach the enclosing
  // `.git` and would otherwise report a dirty tree as clean.
  if (error) return { files: [], diff: "", unreadable: error };
  const currentFingerprints = await fingerprints(config, status);
  const files = baseline
    ? changedSinceBaseline(baseline.fingerprints, currentFingerprints)
    : [...status.keys()];
  if (files.length === 0) return { files: [], diff: "" };

  const trackedFiles = files.filter((path) => status.get(path) !== "??");
  const tracked = trackedFiles.length
    ? await git(config, ["diff", "--binary", "--", ...trackedFiles])
    : { stdout: "" };
  const untracked = files.filter((path) => status.get(path) === "??");

  const untrackedPatches: string[] = [];
  for (const path of untracked.slice(0, 100)) {
    const patch = await git(config, [
      "diff",
      "--no-index",
      "--binary",
      "--",
      "/dev/null",
      path,
    ]);
    untrackedPatches.push(patch.stdout);
  }
  return {
    files,
    diff: [tracked.stdout, ...untrackedPatches].filter(Boolean).join("\n"),
  };
}

async function repositoryStatus(
  config: SunConfig,
): Promise<{ status: Map<string, string>; error?: string }> {
  const result = await git(config, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude).agent",
  ]);
  if (result.exitCode !== 0) {
    return {
      status: new Map(),
      error: result.stderr.trim().split("\n")[0] ?? "git status failed",
    };
  }
  return { status: parsePorcelain(result.stdout) };
}

async function fingerprints(
  config: SunConfig,
  status: Map<string, string>,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    [...status].map(async ([path, code]) => {
      try {
        const content = await readFile(join(config.repository, path));
        const digest = createHash("sha256").update(content).digest("hex");
        return [path, `${code}:${digest}`] as const;
      } catch {
        return [path, `${code}:missing`] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

function changedSinceBaseline(
  baseline: Record<string, string>,
  current: Record<string, string>,
): string[] {
  const paths = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  return [...paths]
    .filter((path) => baseline[path] !== current[path])
    .sort();
}

async function git(config: SunConfig, args: string[]) {
  return await runProcess(["git", ...args], processOptions(config, 30_000));
}

const WORKSPACE_IGNORED_SEGMENTS = new Set([
  ".agent",
  ".cache",
  ".conda",
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tmp",
  ".venv",
  "__pycache__",
  "dist",
  "hf-cache",
  "node_modules",
  "target",
]);

/** Enumerate a multi-project workspace without requiring Git. */
export async function listWorkspaceFiles(
  repository: string,
  limit = 20_000,
): Promise<string[]> {
  const files: string[] = [];
  let directories = [""];
  while (directories.length && files.length < limit) {
    const next: string[] = [];
    for (let offset = 0; offset < directories.length; offset += 32) {
      const batch = directories.slice(offset, offset + 32);
      const listings = await Promise.all(
        batch.map(async (relativeDirectory) => {
          try {
            return await readdir(join(repository, relativeDirectory), {
              withFileTypes: true,
            });
          } catch {
            return [];
          }
        }),
      );
      for (const [index, entries] of listings.entries()) {
        const parent = batch[index] ?? "";
        for (const entry of entries.sort((left, right) =>
          left.name.localeCompare(right.name),
        )) {
          if (WORKSPACE_IGNORED_SEGMENTS.has(entry.name)) continue;
          const path = parent ? `${parent}/${entry.name}` : entry.name;
          if (entry.isDirectory()) next.push(path);
          else if (entry.isFile()) files.push(path);
          if (files.length >= limit) break;
        }
        if (files.length >= limit) break;
      }
      if (files.length >= limit) break;
    }
    directories = next;
  }
  return files.sort();
}

async function listWorkspaceProjects(repository: string): Promise<string[]> {
  const entries = await readdir(repository, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        !WORKSPACE_IGNORED_SEGMENTS.has(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
}

async function workspaceFingerprints(
  repository: string,
): Promise<Record<string, string>> {
  const files = await listWorkspaceFiles(repository, 20_000);
  const entries = await Promise.all(
    files.map(async (path) => {
      try {
        const info = await stat(join(repository, path));
        return [path, `${info.size}:${info.mtimeMs}`] as const;
      } catch {
        return [path, "missing"] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

function processOptions(config: SunConfig, timeoutMs: number) {
  return {
    cwd: config.repository,
    timeoutMs,
    maxOutputBytes: config.maxOutputBytes,
  };
}

function parsePorcelain(raw: string): Map<string, string> {
  const entries = raw.split("\0").filter(Boolean);
  const files = new Map<string, string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    files.set(entry.slice(3), status);
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return files;
}
