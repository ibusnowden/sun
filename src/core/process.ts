import { realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

const GIT_CREDENTIAL_VARIABLES = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITLAB_TOKEN",
  "GLAB_TOKEN",
  "BITBUCKET_TOKEN",
  "SSH_AUTH_SOCK",
] as const;
const SENSITIVE_ENVIRONMENT =
  /(?:^|_)(?:API_?KEY|AUTH|CREDENTIALS?|PASSWORD|PASSWD|PRIVATE_?KEY|SECRET|TOKEN)(?:_|$)|^(?:AWS|AZURE|GCP|GOOGLE|OPENAI|ANTHROPIC|HUGGINGFACE|HF|NPM|DOCKER_AUTH)_/i;

/**
 * Child commands inherit the user's development environment, but not common
 * Git-host credentials. Local Git does not need remote authentication.
 */
export function childEnvironment(
  additions: Record<string, string> = {},
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    ...additions,
  };
  for (const name of Object.keys(environment)) {
    if (SENSITIVE_ENVIRONMENT.test(name)) delete environment[name];
  }
  for (const name of GIT_CREDENTIAL_VARIABLES) delete environment[name];

  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GCM_INTERACTIVE = "Never";
  environment.GIT_ASKPASS = "/bin/false";
  environment.SSH_ASKPASS = "/bin/false";
  environment.GIT_SSH_COMMAND =
    "ssh -o BatchMode=yes -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=/dev/null";

  const configuredCount = Number(environment.GIT_CONFIG_COUNT ?? "0");
  const offset =
    Number.isInteger(configuredCount) && configuredCount >= 0
      ? configuredCount
      : 0;
  environment[`GIT_CONFIG_KEY_${offset}`] = "credential.helper";
  environment[`GIT_CONFIG_VALUE_${offset}`] = "";
  environment.GIT_CONFIG_COUNT = String(offset + 1);
  return environment;
}

export async function runProcess(
  command: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    env?: Record<string, string>;
  },
): Promise<ProcessResult> {
  const cwd = await realpath(options.cwd);
  return await spawnBounded(sandboxCommand(command, cwd), {
    // Bubblewrap performs the --chdir itself.
    cwd: "/",
    env: childEnvironment(options.env),
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
  });
}

/**
 * Runs a command OUTSIDE the sandbox, with the user's real environment and
 * credentials. This is the one capability the sandbox exists to withhold, so
 * it is deliberately not reachable from the `bash` tool: the only caller is
 * the publish path in `tools/publish.ts`, which builds a fixed `git push`
 * argv from validated fields and runs only after the user approves the exact
 * commit being pushed. Never route model-supplied command strings here.
 */
export async function runTrustedProcess(
  command: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
  },
): Promise<ProcessResult> {
  const cwd = await realpath(options.cwd);
  return await spawnBounded(command, {
    cwd,
    env: {
      ...process.env,
      // stdin is closed, so a credential prompt would hang until the timeout
      // rather than ask anyone. Fail fast with a usable message instead.
      GIT_TERMINAL_PROMPT: "0",
    },
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
  });
}

async function spawnBounded(
  command: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    timeoutMs: number;
    maxOutputBytes: number;
  },
): Promise<ProcessResult> {
  const processHandle = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let forceTimer: ReturnType<typeof setTimeout> | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessGroup(processHandle.pid, "SIGTERM");
    forceTimer = setTimeout(() => {
      killProcessGroup(processHandle.pid, "SIGKILL");
    }, 250);
    forceTimer.unref();
  }, options.timeoutMs);

  const outputLimit = Math.max(1, options.maxOutputBytes);
  let stdoutCapture: BoundedOutput;
  let stderrCapture: BoundedOutput;
  let exitCode: number;
  try {
    [stdoutCapture, stderrCapture, exitCode] = await Promise.all([
      readBounded(processHandle.stdout, outputLimit),
      readBounded(processHandle.stderr, outputLimit),
      processHandle.exited,
    ]);
  } finally {
    clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    // Bubblewrap's PID namespace normally removes descendants. The process
    // group cleanup is a second boundary for commands that daemonize.
    killProcessGroup(processHandle.pid, "SIGKILL");
  }

  const combinedBytes = stdoutCapture.totalBytes + stderrCapture.totalBytes;
  const truncated = combinedBytes > outputLimit;

  if (!truncated) {
    return {
      exitCode,
      stdout: stdoutCapture.value,
      stderr: stderrCapture.value,
      timedOut,
      truncated,
    };
  }

  const budget = Math.max(1, Math.floor(outputLimit / 2));
  return {
    exitCode,
    stdout: `${stdoutCapture.bytes.subarray(0, budget).toString()}\n[TRUNCATED]`,
    stderr: `${stderrCapture.bytes.subarray(0, budget).toString()}\n[TRUNCATED]`,
    timedOut,
    truncated,
  };
}

interface BoundedOutput {
  bytes: Buffer;
  value: string;
  totalBytes: number;
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<BoundedOutput> {
  const retained: Buffer[] = [];
  let retainedBytes = 0;
  let totalBytes = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.byteLength;
      if (retainedBytes >= maxBytes) continue;
      const selected = chunk.subarray(0, maxBytes - retainedBytes);
      retained.push(selected);
      retainedBytes += selected.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(retained, retainedBytes);
  return { bytes, value: bytes.toString(), totalBytes };
}

/** Lives on the sandbox tmpfs, so it is discarded when the command ends. */
const SANDBOX_HOME = "/tmp/home";

function sandboxCommand(command: string[], cwd: string): string[] {
  if (process.platform !== "linux") {
    throw new Error(
      "Sun Bash sandboxing currently requires Linux with bubblewrap.",
    );
  }
  const bubblewrap = Bun.which("bwrap");
  if (!bubblewrap) {
    throw new Error(
      'Sun Bash sandboxing requires "bwrap" (bubblewrap) in $PATH.',
    );
  }
  if (!isAbsolute(cwd)) {
    throw new Error(`Sandbox workspace must be absolute: ${cwd}`);
  }

  const args = [
    bubblewrap,
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/sbin",
    "/sbin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    // A writable HOME the command cannot mistake for the workspace. Tools that
    // insist on writing caches and logs to ~ leave the repository clean, so a
    // change summary only ever reports the user's own edits.
    "--dir",
    SANDBOX_HOME,
    ...directoryMounts(cwd),
    "--bind",
    cwd,
    cwd,
  ];

  const bun = Bun.which("bun");
  if (bun && !isInside(cwd, bun) && !isInside("/usr", bun)) {
    args.push(
      "--dir",
      "/opt",
      "--dir",
      "/opt/sun",
      "--dir",
      "/opt/sun/bin",
      "--ro-bind",
      bun,
      "/opt/sun/bin/bun",
    );
  }

  args.push(
    "--setenv",
    "HOME",
    SANDBOX_HOME,
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "PATH",
    sandboxPath(cwd, Boolean(bun)),
    "--chdir",
    cwd,
    "--",
    ...command,
  );
  return args;
}

function directoryMounts(path: string): string[] {
  const mounts: string[] = [];
  const parts = path.split(sep).filter(Boolean);
  let current = "";
  for (const part of parts.slice(0, -1)) {
    current += `${sep}${part}`;
    mounts.push("--dir", current);
  }
  return mounts;
}

function sandboxPath(cwd: string, hasBun: boolean): string {
  const workspaceEntries = (process.env.PATH ?? "")
    .split(":")
    .filter((entry) => entry && isInside(cwd, resolve(entry)));
  const entries = [
    ...(hasBun ? ["/opt/sun/bin"] : []),
    ...workspaceEntries,
    `${cwd}/node_modules/.bin`,
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  return [...new Set(entries)].join(":");
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  );
}

function killProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
