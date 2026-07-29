import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SunConfig } from "../src/core/types.ts";
import {
  describePlan,
  executePublish,
  preparePublish,
  PublishError,
} from "../src/tools/publish.ts";
import { git, temporaryDirectory } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function configFor(root: string, workspaceMode = false): SunConfig {
  return {
    repository: root,
    workspaceMode,
    agentDirectory: join(root, ".agent"),
    provider: "openai-compatible",
    model: "test",
    baseUrl: "http://127.0.0.1:4000/v1",
    apiKeyEnv: "SUN_API_KEY",
    modelTimeoutMs: 5_000,
    modelMaxTokens: 1_000,
    modelContextTokens: 262_144,
    maxToolCalls: 10,
    commandTimeoutMs: 10_000,
    maxOutputBytes: 40_000,
    streamReasoning: false,
  };
}

function commit(root: string, name: string, message: string): void {
  Bun.write(join(root, name), `${message}\n`);
  git(root, "add", "-A");
  git(root, "-c", "user.name=Test", "-c", "user.email=t@example.com", "commit", "-m", message);
}

/**
 * A bare repository on disk is a real Git remote, so the whole publish path —
 * including the unsandboxed push — is exercised without any network.
 */
async function setup(): Promise<{ root: string; remote: string }> {
  const temporary = await temporaryDirectory();
  cleanups.push(temporary.cleanup);
  const root = join(temporary.path, "work");
  const remote = join(temporary.path, "remote.git");
  await mkdir(root, { recursive: true });
  await mkdir(join(root, ".agent"), { recursive: true });
  git(temporary.path, "init", "--bare", "-b", "main", remote);
  git(root, "init", "-b", "main");
  await writeFile(join(root, "one.txt"), "one\n");
  commit(root, "one.txt", "first");
  git(root, "remote", "add", "origin", remote);
  return { root, remote };
}

describe("publish planning", () => {
  test("pins the branch tip and never assembles a force or delete refspec", async () => {
    const { root, remote } = await setup();
    const plan = await preparePublish(configFor(root), {});

    const head = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"])
      .stdout.toString()
      .trim();
    expect(plan.branch).toBe("main");
    expect(plan.remote).toBe("origin");
    expect(plan.remoteUrl).toBe(remote);
    expect(plan.head).toBe(head);
    // The destination is a full ref path, so ":branch" and bare refspecs are
    // unrepresentable, and no force flag exists anywhere in the argv.
    expect(plan.argv).toEqual([
      "git",
      "-C",
      root,
      "push",
      "origin",
      `${head}:refs/heads/main`,
    ]);
    expect(plan.argv.join(" ")).not.toMatch(/--force|-f\b|--delete|--mirror/);
    expect(plan.upstream).toBeNull();
    expect(plan.setUpstream).toBe(true);
  });

  test("describes the commits the user is approving", async () => {
    const { root } = await setup();
    const plan = await preparePublish(configFor(root), {});
    const description = describePlan(plan).join("\n");
    expect(description).toContain("new on the remote");
    expect(description).toContain("1 commit(s) would be published");
    expect(description).toContain("first");
  });

  test("rejects a remote that does not exist", async () => {
    const { root } = await setup();
    await expect(
      preparePublish(configFor(root), { remote: "upstream" }),
    ).rejects.toThrow(/No remote named upstream/);
  });

  test("rejects names Git could read as options", async () => {
    const { root } = await setup();
    for (const remote of ["--force", "-f", "origin;rm -rf /"]) {
      await expect(
        preparePublish(configFor(root), { remote }),
      ).rejects.toBeInstanceOf(PublishError);
    }
    for (const branch of ["--mirror", "../evil", "main..other"]) {
      await expect(
        preparePublish(configFor(root), { branch }),
      ).rejects.toBeInstanceOf(PublishError);
    }
  });

  test("refuses a detached HEAD instead of guessing a branch", async () => {
    const { root } = await setup();
    const head = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"])
      .stdout.toString()
      .trim();
    git(root, "checkout", "--detach", head);
    await expect(preparePublish(configFor(root), {})).rejects.toThrow(
      /HEAD is detached/,
    );
  });

  test("refuses a workspace that is not a repository", async () => {
    const { root } = await setup();
    await expect(
      preparePublish(configFor(root, true), {}),
    ).rejects.toThrow(/not a Git repository/);
  });
});

describe("publish execution", () => {
  test("pushes the approved commit to a real remote", async () => {
    const { root, remote } = await setup();
    const plan = await preparePublish(configFor(root), {});
    const result = await executePublish(plan, 40_000);

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Published 1 commit(s) to origin/main");
    const pushed = Bun.spawnSync(["git", "-C", remote, "rev-parse", "refs/heads/main"])
      .stdout.toString()
      .trim();
    expect(pushed).toBe(plan.head);
    // setUpstream was implied for a new branch, and is a local config write.
    const upstream = Bun.spawnSync([
      "git",
      "-C",
      root,
      "rev-parse",
      "--abbrev-ref",
      "main@{upstream}",
    ])
      .stdout.toString()
      .trim();
    expect(upstream).toBe("origin/main");
  });

  test("publishes only the approved commit when the branch moves after planning", async () => {
    const { root, remote } = await setup();
    const plan = await preparePublish(configFor(root), {});
    // A later edit must not ride along on an approval already given.
    await writeFile(join(root, "two.txt"), "two\n");
    commit(root, "two.txt", "second");

    const result = await executePublish(plan, 40_000);
    expect(result.ok).toBe(true);
    const pushed = Bun.spawnSync(["git", "-C", remote, "rev-parse", "refs/heads/main"])
      .stdout.toString()
      .trim();
    expect(pushed).toBe(plan.head);
    expect(pushed).not.toBe(
      Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"]).stdout.toString().trim(),
    );
  });

  test("reports an up-to-date branch without contacting the remote", async () => {
    const { root } = await setup();
    await executePublish(await preparePublish(configFor(root), {}), 40_000);
    const second = await preparePublish(configFor(root), {});

    expect(second.commits).toEqual([]);
    const result = await executePublish(second, 40_000);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("already up to date");
    expect(result.metadata?.pushed).toBe(false);
  });

  test("explains a rejected non-fast-forward instead of forcing it", async () => {
    const { root, remote } = await setup();
    await executePublish(await preparePublish(configFor(root), {}), 40_000);

    // Move the remote ahead from a second clone, then try to publish a
    // divergent history from the original.
    const other = join(root, "..", "other");
    git(root, "clone", remote, other);
    await writeFile(join(other, "remote-only.txt"), "remote\n");
    commit(other, "remote-only.txt", "remote side");
    git(other, "push", "origin", "main");

    await writeFile(join(root, "local-only.txt"), "local\n");
    commit(root, "local-only.txt", "local side");
    const plan = await preparePublish(configFor(root), {});
    const result = await executePublish(plan, 40_000);

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("failed");
    expect(result.output).toMatch(/Sun never force-pushes/);
  });
});
