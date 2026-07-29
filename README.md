# Sun

Sun is a small TypeScript/Bun coding agent with a terminal UI. It points at an
OpenAI-compatible model, works directly in the current workspace, and has five
tools:

```text
read  edit  write  bash  publish
```

There is one loop:

```text
user → model → one tool → result → model → … → answer
```

There is no planner, reviewer, repair state machine, memory system, session
artifact recorder, worktree manager, or permission-tier engine. Every Bash
command pauses at an approval card and then runs in a Linux Bubblewrap
sandbox. The second choice on that card approves Bash for the rest of that Sun
session without removing the sandbox.

`/goal` is the one thing that outlives a single answer: it gives Sun an
objective it keeps working toward across turns. The loop is unchanged — a goal
just decides what the next task is.

`/plan` switches Sun into plan mode, where it investigates with `read` and
`bash` and proposes a change without making one. `edit`, `write`, and `publish`
are refused by the tool registry, not merely discouraged in the prompt, so the
guarantee holds even if the model tries. When the plan arrives you choose
whether to run it; approving switches back to work mode and hands the plan
straight back as the next task.

## Install

```bash
bun install -g @ibusnowden/sun
```

Sun requires Linux with `bwrap` (Bubblewrap) installed, and Bun ≥ 1.3 — the
sandbox and the process layer are built on both, so neither is optional. Bun is
also what installs it: the published `bin` is TypeScript with a `#!/usr/bin/env
bun` shebang, so `npm i -g` would fetch the package and then fail to run it.
Install with Bun, or take the standalone binary below.

To work on Sun itself, link the checkout instead:

```bash
bun install
bun link
```

For a standalone binary that carries its own runtime and prompts:

```bash
bun run build      # → dist/sun, a single ~100 MB executable
./dist/sun --help
```

The prompts are embedded at build time via text imports rather than read from
disk, so the binary works anywhere; `bun run check` (typecheck + tests) runs on
`prepack`. Tagged releases attach the same binary to the GitHub release.

Once installed, `sun` is available globally:

```bash
cd /project/inniang
sun
```

Sun uses the directory where it was launched as its workspace. It also accepts
a task directly:

```bash
sun "explain this project"
sun --repo /absolute/path/to/project "fix the failing test"
sun --plain "print the package name"
```

The old `sun inspect`, `sun work`, and `sun execute` forms remain aliases, but
they all run the same simple agent.

## Updating

```bash
sun update           # install the latest release
sun update --check   # report what is available, change nothing
```

Interactive sessions check once a day and, when there is something newer, say
so on one line under the header. The check is cached in
`$XDG_CACHE_HOME/sun/update.json` (falling back to `~/.cache`), never runs
under `--plain` so scripted use pays nothing for it, and treats every failure —
offline, rate-limited, package not yet published — as "nothing to report"
rather than as an error. A registry lookup is not allowed to stop Sun starting.

`sun update` delegates to `bun install -g`, because whatever installed Sun is
the thing that knows how to replace it. Run from a `bun link`ed checkout it
refuses and points at `git pull`, rather than shadowing your working tree with
a registry copy.

Releases are cut by pushing a tag: `v0.2.0` publishes 0.2.0 to npm and attaches
a Linux binary to the GitHub release. CI refuses a tag that disagrees with
`package.json`, and the version the CLI reports is read from that same manifest
(`src/version.ts`), so the three can never drift apart.

## Local GLM-5.2

`sun init` creates only `.agent/config.toml`. The defaults target the local
OpenAI-compatible router:

```toml
provider = "openai-compatible"
model = "glm-5.2"
base_url = "http://127.0.0.1:4000/v1"
api_key_env = "SUN_API_KEY"
model_timeout_ms = 600000
model_max_tokens = 16384
model_context_tokens = 262144
max_tool_calls = 50
command_timeout_ms = 120000
max_output_bytes = 100000
stream_reasoning = true
```

When `SUN_API_KEY` is unset, the local provider sends the non-secret fallback
value `local`.

```bash
sun doctor
```

## Terminal design

The interface follows Codex's, recorded in
[design/codex-ui.md](design/codex-ui.md): one bullet per event at column 0,
detail indented under it, and two connectors — `│` for a command that wrapped,
`└` for the head of its output. There is no gutter, no tool-name column, no
right-aligned metadata, and no boxed input. Finished work stays in normal
terminal scrollback; only the reasoning window, the working row, the composer,
and the status line live at the bottom.

```text
╭─────────────────────────────────────────╮
│ >_ Sun (v0.1.0)                         │
│                                         │
│ model:     glm-5.2   /model to change   │
│ directory: /project/inniang/sun         │
╰─────────────────────────────────────────╯

  Tip: Use /goal to give Sun an objective that outlives a single answer.

› refactor the config loader

• Reading the current implementation first.

• Read src/config.ts (84 lines)

• Edited src/config.ts (+21 -9)
    41 -const timeout = 1_000
    41 +const timeout = 60_000

• Ran bun test (4s)
  └ 45 pass
    0 fail

────────────────────────────────────────────────────────────────────────

• Widened the loader timeout and the tests still pass.

────────────────────────────────────────────────────────────────────────

› Explain this codebase

  glm-5.2 · /project/inniang/sun                             18.2k tokens
```

While a turn is in flight, the model's reasoning streams into the live region
and the working row says what is taking the time:

```text
• The failure looks timing dependent. I should check whether the test awaits
  the token refresh before asserting.

• Running bun test tests/auth.test.ts (22s • esc to interrupt)
```

Every modal choice is the same numbered list — approving a command, `/model`,
`/approvals`:

```text
  Allow Sun to run this command?
  rm -rf ./dist

› 1. Yes, run it
  2. Yes, and stop asking about bash this session
  3. No, and let me steer instead

  Press enter to confirm, esc to skip the command
```

## Goals

`/goal <objective>` sets an objective Sun keeps working toward. Each turn ends
normally, and the session immediately starts the next one with a continuation
prompt carrying the objective, the turn count, and the token budget.

```bash
/goal make the flaky auth test pass
/goal port the parser to the new AST --budget 250k
/goal                  # show the current goal
/goal pause            # stop the loop, keep the objective
/goal resume           # start pursuing it again
/goal clear            # forget it
```

The model reports a verdict on each goal turn — achieved, continue, or blocked
— and Sun, not the model, decides what that verdict costs:

- **achieved** ends the goal, but only after the model's own completion audit;
  the continuation prompt requires evidence for every requirement and treats
  uncertain evidence as not achieved.
- **blocked** has to repeat for three consecutive turns before it stops
  anything, so one bad turn cannot end a long task.
- an exhausted budget stops the goal as `budget spent`, never as complete. A
  goal that ran out of room is not a goal that was finished.
- `esc` pauses rather than ends, and the objective survives to be resumed.

The goal lives in `.agent/goal.json` and its objective is replayed to the model
wrapped as untrusted data, so a stored objective cannot rewrite the rules it is
being pursued under.

Sun does not require or store a GitHub login. Child commands do not receive
common GitHub/GitLab tokens, the SSH agent socket, interactive credential
prompts, or configured Git credential helpers. Local Git operations still work,
including status, diff, branches, staging, and commits.

Pushing is the one thing that needs the network and your credentials, so it is
not a Bash command at all — it is the `publish` tool, and it is the only code
path that runs outside the sandbox. Bash keeps no network access whatsoever.
`publish` composes its own `git push` argv from a validated remote and branch;
the model never supplies a command string. Before anything is sent you get an
approval card naming the remote URL, the branch, and the commits, and that card
cannot be silenced: `/approvals` auto mode and "stop asking" both stop at it.
The refspec is always `<approved-sha>:refs/heads/<branch>`, so a later edit
cannot ride along on an approval you already gave, a deletion refspec is
unrepresentable, and no force flag is ever assembled.

Approved Bash commands can write only inside the selected workspace. System
runtimes are mounted read-only, unrelated home files are absent, networking is
disabled, secret-like environment variables are removed, output is
memory-bounded, and the sandbox removes background processes when the command
finishes. `HOME` points at a throwaway directory on the sandbox tmpfs, so tools
that cache or log into `~` leave the workspace clean and Sun's change summary
only reports your own edits. Terminal-bound model and command text is sanitized before display.

Available slash commands are `/goal`, `/plan`, `/model`, `/approvals`,
`/tokens`, `/diff`,
`/files`, `/help`, `/clear`, and `/quit`. Typing `/` at the start of a line
lists them under the composer, and `@` anywhere completes a workspace path;
`↑`/`↓` move through the menu and `tab` accepts the highlight. Completing a
path only inserts text — Sun still decides for itself whether to read the
file, so `@` never quietly spends your context window.

`/model` lists what the configured endpoint actually reports, the same list
`sun doctor` prints, and switches the next turn onto the chosen one without
touching the conversation. `/approvals` chooses whether Sun stops before each
command; the sandbox applies either way.

`/tokens` (also `/usage`) breaks down what the session has spent: the running
total and prompt/completion split, the last call on its own, the per-call
average, and the peak prompt as a share of the context window. The context line
reports the peak prompt rather than the total, because only the prompt counts
against the window and the peak is what a long session actually runs out of.

It also reports **per-tool cost**. The tool registry estimates the tokens each
result adds to the next prompt and attributes them to the tool that produced
them, so `By tool` answers "what is eating my context window" — usually a
`bash` command that printed more than anyone wanted:

```text
By tool
  bash  412k from 38 calls · 2 failed · 3 truncated
  read   54k from 11 calls
```

`/usage daily` (also `weekly` and `cumulative`) draws a year of activity as a
contributions grid, with lifetime, peak day, current and best streak, and the
longest single task:

```text
 Token activity   last 12 months
 Lifetime 121.17M · Peak 5.34M · Streak 17d (best 17d) · Longest task 11h 10m

      Aug       Sep     Oct     Nov       Dec     Jan     Feb     Mar  …
 Su □ □ ■ □ □ □ □ ■ □ □ □ □ □ ■ ■ □ □ ■ □ ■ ■ ■ ■ ■ ■ ■ □ □ □ ■ □ □ ■ …
 …

   Less □ ■ ■ ■ ■ More
   daily · weekly · cumulative
```

`daily` colours each day on its own, `weekly` gives every day in a column its
week's total so the grid reads as bars, and `cumulative` shows the running
total. Levels are quartiles of the non-zero values, so one enormous day cannot
flatten everything else into the lowest step. A narrow terminal keeps the most
recent weeks that fit and says how many it is showing.

The layout, glyphs, and colours were read off a live `codex-cli 0.145.0` under
a pty rather than guessed. One deliberate difference: Codex renders cells as a
binary on/off even though its own legend promises "Less → More", so Sun gives
the legend meaning with four steps whose brightest is Codex's exact colour — a
saturated grid looks identical, a mixed one says more.

Finally it reports **this week and this month**, which outlive the session.
Spend is bucketed by local calendar day in `.agent/usage.json` (gitignored, and
pruned past 400 days). The periods are calendar-based — a week begins Monday, a
month on the 1st — and each line names its start date, so the figure is never
ambiguous about which window it covers.

The live transcript shows a compact preview after each changed patch. `/diff`
is the one command that does not write to the transcript: it takes the
alternate screen and opens a full-screen pager over the raw working-tree diff,
untracked files included, read at the moment you ask rather than carried over
from the last turn.

```text
/ D I F F / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / /
diff --git a/math.js b/math.js
index 0604766..0bd82db 100644
--- a/math.js
+++ b/math.js
@@ -1,3 +1,7 @@
 export function add(a, b) {
   return a + b
 }
+
+export function subtract(a, b) {
+  return a - b
+}
~
~
──────────────────────────────────────────────────────────────────────── 0% ─
 ↑/↓ to scroll   pgup/pgdn to page   home/end to jump
 q to quit
```

`↑`/`↓` and `j`/`k` move a row, `pgup`/`pgdn` a screenful, `home`/`end` jump to
either end, and `q` or `esc` closes it and puts the transcript back. Rows past
the end of the patch are marked `~`, and long lines break at the column rather
than at a word, so the columns being compared stay aligned. Leaving the pager
restores the scrollback underneath untouched.

Every dimension here — the letter-spaced header, the five rows of chrome, the
percentage on the rule, the page step, and which keys do nothing — was measured
off a live `codex-cli` under a pty, and the rendered frame matches it line for
line. `j`/`k` are bound because Codex binds them; `gg`, `G`, `ctrl+d`, and
`ctrl+u` are deliberately left unbound for the same reason. The one difference
is under the surface: Sun paints through its own named palette rather than
Codex's 256-colour codes, so the colours match but the escape sequences differ.

Assistant replies are rendered as Markdown:
emphasis, inline code, lists, headings, quotes, tables, and fenced blocks are
laid out rather than printed with their punctuation. Press `esc` to clear a
non-empty input, or to interrupt a run and keep the partial transcript.

## Development

```bash
bun run check
```

The architecture decision is stored in [docs/design.md](docs/design.md).
