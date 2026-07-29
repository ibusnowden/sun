import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertGitRepository,
  assertWorkspaceDirectory,
  listWorkspaceFiles,
} from "../src/repository/inspect.ts";
import { git, temporaryDirectory } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("workspace discovery", () => {
  test("enumerates nested projects while pruning dependency and Git metadata", async () => {
    const temporary = await temporaryDirectory();
    cleanups.push(temporary.cleanup);
    await Promise.all([
      mkdir(join(temporary.path, "alpha", "src"), { recursive: true }),
      mkdir(join(temporary.path, "alpha", "node_modules", "dep"), {
        recursive: true,
      }),
      mkdir(join(temporary.path, "beta", ".git"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(temporary.path, "alpha", "src", "index.ts"), "export {}"),
      writeFile(
        join(temporary.path, "alpha", "node_modules", "dep", "index.js"),
        "ignored",
      ),
      writeFile(join(temporary.path, "beta", "README.md"), "# Beta"),
      writeFile(join(temporary.path, "beta", ".git", "HEAD"), "ignored"),
    ]);

    await expect(assertWorkspaceDirectory(temporary.path)).resolves.toBeUndefined();
    expect(await listWorkspaceFiles(temporary.path)).toEqual([
      "alpha/src/index.ts",
      "beta/README.md",
    ]);
  });
});

describe("assertGitRepository", () => {
  test("returns the repository root", async () => {
    const temporary = await temporaryDirectory();
    cleanups.push(temporary.cleanup);
    git(temporary.path, "init", "-b", "main");
    expect(await assertGitRepository(temporary.path)).toBe(temporary.path);
  });

  test("gives actionable guidance outside Git", async () => {
    const temporary = await temporaryDirectory();
    cleanups.push(temporary.cleanup);
    await expect(assertGitRepository(temporary.path)).rejects.toThrow(
      "--repo /absolute/path/to/repository",
    );
  });
});
