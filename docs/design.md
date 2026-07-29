# Sun design

Source references:

- [Original shared conversation](https://chatgpt.com/share/6a644665-3840-83ea-926b-f14c33cd8fd4)
- `design/codex-ui.md` — the interface, captured off a live `codex-cli 0.145.0`
- `design/Screenshot 2026-07-26 at 2.00.14 PM.png` (superseded)
- `design/Screenshot 2026-07-26 at 2.00.21 PM.png` (superseded)

## Product

Sun is a general-purpose local coding agent, not a supervised harness. It is
installed as the global `sun` command and treats the launch directory as the
workspace.

The architecture is intentionally one direct loop:

```text
┌────────────┐
│ user input │
└─────┬──────┘
      ▼
┌────────────┐       ┌────────────────────────┐
│ model      │──────▶│ read / edit / write /  │
│ decision   │◀──────│ bash                   │
└─────┬──────┘ result└────────────────────────┘
      ▼
┌────────────┐
│ final text │
└────────────┘
```

Each model turn chooses exactly one tool, completes, or reports that it is
blocked. Tool results are appended to the next model context. User steering
typed during a run joins that same context at the next decision boundary.

One thing sits above that loop: a goal. `/goal` stores an objective, and when a
turn ends with a goal active the session starts the next turn itself, carrying
a continuation prompt instead of waiting for input. The loop does not change —
a goal only decides what the next task is. The model reports a verdict
(achieved, continue, blocked) on its `complete` decision, and the session, not
the model, decides what that verdict costs: an exhausted budget stops the goal
as `budget_limited` rather than complete, and a `blocked` claim must repeat for
three consecutive turns. See `src/agent/goal.ts`.

## Deliberately absent

Sun does not have:

- planning, review, reflection, or repair model phases;
- policy tiers or separate inspect/work/execute authority modes;
- isolated Git worktrees;
- persistent memory or lesson promotion;
- per-run session artifacts;
- a structured search tool.

File discovery, text search, Git commands, and tests use `bash`.

## Four tools

- `read`: read a known UTF-8 file or line range;
- `edit`: replace an exact text match in an existing file;
- `write`: create a file or intentionally overwrite one;
- `bash`: run an approved shell command in the selected workspace with a
  timeout and bounded captured output.

File tools stay within the launch workspace. Bash runs in a Linux Bubblewrap
mount/PID/network namespace: the workspace is writable, system runtimes are
read-only, unrelated home files are absent, `HOME` is a throwaway tmpfs
directory rather than the workspace, networking is disabled, and secret-like
environment variables are removed. Descendants are removed when the command
ends. Every Bash call still pauses at a numbered approval card: the first
choice allows one command, the second allows Bash for the rest of the current
terminal session without disabling the sandbox, and the third skips while
placing replacement text in the editor. `/approvals` switches the default
between asking and running straight into the sandbox.

Sun has no GitHub login flow and stores no Git credentials. Child processes do
not receive common Git-host tokens, the SSH agent socket, credential helpers,
or interactive credential prompts. Local Git continues to work; authenticated
remote operations stay outside Sun.

All model, tool, path, diff, and command text is stripped of terminal control
sequences before display. Sun preserves only its own limited color SGR codes.

## TUI contract

`design/codex-ui.md` is the visual source of truth. The organising idea is one
bullet per event at column 0 with detail indented under it, so depth is carried
by indentation rather than by a vocabulary of markers:

- `›` opens a user message and marks the selected row in a menu;
- `•` opens every agent event — prose, command, edit, notice;
- `└` heads a command's output; later lines align under it with plain spaces;
- `│` continues a command that did not fit on one line;
- a tool headline names its action and carries one parenthesised stat:
  `Read src/config.ts (84 lines)`, `Edited src/config.ts (+21 -9)`,
  `Ran bun test (exit 1)`;
- edit previews are numbered rows, `41 -old` / `41 +new`, with the lines both
  sides share trimmed away; `/diff` retains the full cumulative patch;
- a full-width `─` rule closes each turn;
- every modal choice is one numbered list with a title, a subtitle, and
  `Press enter to confirm or esc to go back`;
- a content-sized header box, a rotating composer placeholder, and one dim
  status line of model, workspace, goal badge, and tokens;
- no dashboard, panels, state-machine labels, or cost display.

The transcript stays in normal terminal scrollback. The live region holds the
streamed model reasoning, the working row, the composer, and the status line,
and is the only thing redrawn when the terminal changes size.

Model reasoning is shown while it arrives — a window onto the stream, tail
only, cleared as soon as the model commits to an action. What survives into
scrollback is the narration bullet, not the raw reasoning.

Final responses lead with the result, group repository details by purpose, and
avoid exhaustive filename dumps. Change handoffs name the important edits and
verification without repeating raw tool output.

## Model connection

The default provider is `glm-5.2` at
`http://127.0.0.1:4000/v1` using OpenAI-compatible Chat Completions and one
JSON-schema decision format. The client context ceiling is 262,144 tokens.
