import { runProcess, runTrustedProcess } from "../core/process.ts";
import type { SunConfig, ToolResult } from "../core/types.ts";

/**
 * Publishing is the one thing Sun does with the network, so it is built as a
 * fixed operation rather than a command the model composes. The model chooses
 * only a remote name, a branch name, and whether to set upstream tracking;
 * every argv passed to Git is assembled here.
 *
 * Two properties matter and are enforced below:
 *
 * 1. The user approves a specific commit. The plan resolves the branch tip to
 *    a SHA and pushes `<sha>:refs/heads/<branch>`, so a later edit cannot ride
 *    along on an approval the user already gave.
 * 2. History is never rewritten. No force flag is ever assembled, and the
 *    destination is always a full `refs/heads/` path, which makes a deletion
 *    refspec (`:branch`) or an arbitrary refspec unrepresentable.
 */

const PUBLISH_TIMEOUT_MS = 120_000;
const PREVIEW_COMMITS = 10;

/** Rejects anything Git could read as an option, plus separators and globs. */
const REMOTE_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const BRANCH_NAME = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

export interface PublishInput {
  remote?: string | null | undefined;
  branch?: string | null | undefined;
  setUpstream?: boolean | null | undefined;
}

export interface PublishPlan {
  root: string;
  remote: string;
  remoteUrl: string;
  branch: string;
  head: string;
  setUpstream: boolean;
  /** Present when the remote-tracking branch already exists locally. */
  upstream: string | null;
  commits: string[];
  argv: string[];
  /** Shown to the user in the approval prompt. */
  command: string;
}

export class PublishError extends Error {}

export async function preparePublish(
  config: SunConfig,
  input: PublishInput,
): Promise<PublishPlan> {
  if (config.workspaceMode) {
    throw new PublishError(
      "This workspace is not a Git repository, so there is nothing to publish.",
    );
  }

  const root = (
    await git(config.repository, ["rev-parse", "--show-toplevel"])
  ).trim();

  const remote = input.remote?.trim() || "origin";
  if (!REMOTE_NAME.test(remote)) {
    throw new PublishError(`Unsupported remote name: ${remote}`);
  }

  const branch = input.branch?.trim() || (await currentBranch(root));
  if (!BRANCH_NAME.test(branch) || branch.includes("..")) {
    throw new PublishError(`Unsupported branch name: ${branch}`);
  }
  await git(root, ["check-ref-format", "--branch", branch]).catch(() => {
    throw new PublishError(`Git rejects ${branch} as a branch name.`);
  });

  const remoteUrl = await git(root, ["remote", "get-url", remote]).catch(() => {
    throw new PublishError(
      `No remote named ${remote} in this repository. Add one, or name an existing remote.`,
    );
  });

  const head = (
    await git(root, ["rev-parse", "--verify", `refs/heads/${branch}`]).catch(
      () => {
        throw new PublishError(`${branch} is not a local branch.`);
      },
    )
  ).trim();

  const upstream = await resolveUpstream(root, remote, branch);
  const range = upstream ? `${upstream}..${head}` : head;
  const commits = (
    await git(root, [
      "log",
      "--no-color",
      `--max-count=${PREVIEW_COMMITS + 1}`,
      "--format=%h %s",
      range,
    ])
  )
    .split("\n")
    .filter(Boolean);

  const argv = [
    "git",
    "-C",
    root,
    "push",
    remote,
    `${head}:refs/heads/${branch}`,
  ];

  return {
    root,
    remote,
    remoteUrl: remoteUrl.trim(),
    branch,
    head,
    setUpstream: input.setUpstream ?? !upstream,
    upstream,
    commits,
    argv,
    command: `git push ${remote} ${head.slice(0, 12)}:refs/heads/${branch}`,
  };
}

/** The lines shown above the approval choices. */
export function describePlan(plan: PublishPlan): string[] {
  const lines = [
    `Remote   ${plan.remote} → ${plan.remoteUrl}`,
    `Branch   ${plan.branch}${plan.upstream ? "" : "  (new on the remote)"}`,
    `Commit   ${plan.head.slice(0, 12)}`,
  ];
  if (plan.commits.length === 0) {
    lines.push("", "Already published. Nothing would be sent.");
    return lines;
  }
  const shown = plan.commits.slice(0, PREVIEW_COMMITS);
  lines.push(
    "",
    `${plan.commits.length > PREVIEW_COMMITS ? `${PREVIEW_COMMITS}+` : plan.commits.length} commit(s) would be published:`,
    ...shown.map((line) => `  ${line}`),
  );
  if (plan.commits.length > PREVIEW_COMMITS) lines.push("  …");
  return lines;
}

export async function executePublish(
  plan: PublishPlan,
  maxOutputBytes: number,
): Promise<ToolResult> {
  if (plan.commits.length === 0) {
    return {
      ok: true,
      summary: `${plan.remote}/${plan.branch} is already up to date; nothing was published`,
      output: "",
      metadata: { remote: plan.remote, branch: plan.branch, pushed: false },
    };
  }

  const result = await runTrustedProcess(plan.argv, {
    cwd: plan.root,
    timeoutMs: PUBLISH_TIMEOUT_MS,
    maxOutputBytes,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

  if (result.timedOut) {
    return {
      ok: false,
      summary: `Push timed out after ${PUBLISH_TIMEOUT_MS / 1000}s`,
      output,
      exitCode: result.exitCode,
      metadata: { remote: plan.remote, branch: plan.branch, pushed: false },
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      summary: `Push to ${plan.remote}/${plan.branch} failed`,
      output: `${output}\n\n${pushHint(output)}`.trim(),
      exitCode: result.exitCode,
      metadata: { remote: plan.remote, branch: plan.branch, pushed: false },
    };
  }

  // Tracking is a local config write, so it stays off the trusted path. It is
  // also non-fatal: the commits are already published either way.
  let tracking = "";
  if (plan.setUpstream) {
    const linked = await git(plan.root, [
      "branch",
      `--set-upstream-to=${plan.remote}/${plan.branch}`,
      plan.branch,
    ]).then(
      () => true,
      () => false,
    );
    tracking = linked ? `; tracking ${plan.remote}/${plan.branch}` : "";
  }

  return {
    ok: true,
    summary: `Published ${plan.commits.length} commit(s) to ${plan.remote}/${plan.branch}${tracking}`,
    output,
    exitCode: 0,
    metadata: {
      remote: plan.remote,
      branch: plan.branch,
      head: plan.head,
      pushed: true,
    },
  };
}

function pushHint(output: string): string {
  if (/non-fast-forward|fetch first|rejected/i.test(output)) {
    return "The remote has commits this branch does not. Pull or rebase, then publish again. Sun never force-pushes.";
  }
  if (/could not read from remote|permission denied|authentication/i.test(output)) {
    return "Git could not authenticate to the remote. Check the credentials this repository uses for that remote.";
  }
  if (/could not resolve host|network is unreachable|timed out/i.test(output)) {
    return "The remote host was unreachable from this machine.";
  }
  return "";
}

async function currentBranch(root: string): Promise<string> {
  const branch = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    .then((value) => value.trim())
    .catch(() => "");
  if (!branch) {
    throw new PublishError(
      "HEAD is detached, so there is no branch to publish. Check out a branch first, or name one.",
    );
  }
  return branch;
}

async function resolveUpstream(
  root: string,
  remote: string,
  branch: string,
): Promise<string | null> {
  const ref = `refs/remotes/${remote}/${branch}`;
  return await git(root, ["rev-parse", "--verify", "--quiet", ref]).then(
    () => `${remote}/${branch}`,
    () => null,
  );
}

/**
 * Local, read-only Git. These never touch the network, so they run inside the
 * sandbox for the same reason every other command does.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess(["git", ...args], {
    cwd,
    timeoutMs: 30_000,
    maxOutputBytes: 200_000,
  });
  if (result.exitCode !== 0) {
    throw new PublishError(
      (result.stderr || result.stdout).trim() ||
        `git ${args[0]} failed with exit code ${result.exitCode}`,
    );
  }
  return result.stdout;
}
