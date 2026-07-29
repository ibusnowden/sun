import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  childEnvironment,
  runProcess,
} from "../src/core/process.ts";
import { git, temporaryDirectory } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("child process environment", () => {
  test("does not expose Git-host tokens or the SSH agent", () => {
    const environment = childEnvironment({
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      OPENAI_API_KEY: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
    });

    expect(environment.GH_TOKEN).toBeUndefined();
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment.SSH_AUTH_SOCK).toBeUndefined();
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(environment.GIT_TERMINAL_PROMPT).toBe("0");
    const credentialEntry = Object.entries(environment).find(
      ([name, value]) =>
        name.startsWith("GIT_CONFIG_KEY_") && value === "credential.helper",
    );
    expect(credentialEntry).toBeDefined();
    const suffix = credentialEntry?.[0].slice("GIT_CONFIG_KEY_".length);
    expect(environment[`GIT_CONFIG_VALUE_${suffix}`]).toBe("");
  });

  test("local Git commits still work without remote credentials", async () => {
    const temporary = await temporaryDirectory();
    cleanups.push(temporary.cleanup);
    git(temporary.path, "init", "-b", "main");
    await writeFile(join(temporary.path, "README.md"), "local only\n");
    git(temporary.path, "add", "README.md");

    const result = await runProcess(
      [
        "git",
        "-c",
        "user.name=Sun Test",
        "-c",
        "user.email=sun@example.invalid",
        "commit",
        "-m",
        "local commit",
      ],
      {
        cwd: temporary.path,
        timeoutMs: 10_000,
        maxOutputBytes: 20_000,
        env: {
          GH_TOKEN: "must-not-be-used",
          SSH_AUTH_SOCK: "/tmp/missing-agent.sock",
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("local commit");
  });

  test("confines reads and writes to the selected workspace", async () => {
    const workspace = await temporaryDirectory("sun-sandbox-workspace-");
    const outside = await temporaryDirectory("sun-sandbox-outside-");
    cleanups.push(workspace.cleanup, outside.cleanup);
    await writeFile(join(outside.path, "secret.txt"), "outside secret");

    const result = await runProcess(
      [
        "bash",
        "-lc",
        `cat '${join(outside.path, "secret.txt")}'; printf escaped > '${join(outside.path, "created.txt")}'; printf allowed > ./inside.txt`,
      ],
      {
        cwd: workspace.path,
        timeoutMs: 2_000,
        maxOutputBytes: 20_000,
      },
    );

    expect(result.stdout).not.toContain("outside secret");
    expect(await Bun.file(join(outside.path, "created.txt")).exists()).toBeFalse();
    expect(await readFile(join(workspace.path, "inside.txt"), "utf8")).toBe(
      "allowed",
    );
  });

  test("blocks network access, including host loopback services", async () => {
    const workspace = await temporaryDirectory("sun-sandbox-network-");
    cleanups.push(workspace.cleanup);
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("reachable"),
    });
    try {
      const result = await runProcess(
        [
          "bash",
          "-lc",
          `exec 3<>/dev/tcp/127.0.0.1/${server.port}; printf ping >&3; cat <&3`,
        ],
        {
          cwd: workspace.path,
          timeoutMs: 2_000,
          maxOutputBytes: 20_000,
        },
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("reachable");
    } finally {
      server.stop(true);
    }
  });

  test("reaps background jobs when the approved command finishes", async () => {
    const workspace = await temporaryDirectory("sun-sandbox-background-");
    cleanups.push(workspace.cleanup);
    const started = performance.now();
    const result = await runProcess(
      ["bash", "-lc", "sleep 30 & echo finished"],
      {
        cwd: workspace.path,
        timeoutMs: 2_000,
        maxOutputBytes: 20_000,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("finished");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("force-kills commands that ignore the graceful timeout signal", async () => {
    const workspace = await temporaryDirectory("sun-sandbox-timeout-");
    cleanups.push(workspace.cleanup);
    const started = performance.now();
    const result = await runProcess(
      ["bash", "-lc", "trap '' TERM; while :; do :; done"],
      {
        cwd: workspace.path,
        timeoutMs: 25,
        maxOutputBytes: 1_024,
      },
    );

    expect(result.timedOut).toBeTrue();
    expect(result.exitCode).not.toBe(0);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("retains only bounded output from noisy commands", async () => {
    const workspace = await temporaryDirectory("sun-sandbox-output-");
    cleanups.push(workspace.cleanup);
    const result = await runProcess(
      [
        "bash",
        "-lc",
        "head -c 1048576 /dev/zero | tr '\\0' x; head -c 1048576 /dev/zero | tr '\\0' y >&2",
      ],
      {
        cwd: workspace.path,
        timeoutMs: 2_000,
        maxOutputBytes: 1_024,
      },
    );

    expect(result.truncated).toBeTrue();
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(600);
    expect(Buffer.byteLength(result.stderr)).toBeLessThan(600);
  });
});
