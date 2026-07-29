# The Codex UI, as captured

Reference for Sun's terminal interface. Everything below was read off a live
`codex-cli 0.145.0` driven under a pty at 110 columns, plus the goal state
model recovered from the binary and `~/.codex/goals_1.sqlite`. This file
supersedes `design/*.png` and `design/gutter.ts`, which describe the earlier
gutter-and-columns interface.

The organising idea: **one bullet per event, at column 0, with detail indented
under it.** There is no gutter, no tool-name column, no right-aligned meta, and
no boxed input. Depth is carried by indentation and two connector glyphs.

## Header

A rounded box sized to its content, not to the terminal.

```
╭────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.145.0)                         │
│                                                    │
│ model:     gpt-5.6-sol high   /model to change     │
│ directory: /tmp/claude-63735/…/scratchpad/codexbox │
╰────────────────────────────────────────────────────╯

  Tip: Use /copy or press Ctrl+O to copy the latest agent response as Markdown.

• You have 2 usage limit resets available. Run /usage to use one.
```

- The label column (`model:`, `directory:`) is padded to a common width.
- A long directory is shortened in the **middle** with `…`, keeping the head
  and the last two segments.
- The tip is indented two spaces and dim.
- Standalone notices use the same `•` bullet as the transcript.

## Transcript

```
› read math.js and add a subtract function to it

• I'll inspect the existing module and its local conventions, then add
  subtract and run any relevant checks.

• Ran pwd && rg --files -g 'math.js' -g 'package.json'
  └ /tmp/claude-63735/…/scratchpad/codexbox
    math.js

• Edited math.js (+4 -0)
    3  }
    4 +
    5 +export function subtract(a, b) {
    6 +  return a - b
    7 +}

• Ran node --input-type=module -e "import('./math.js').then(({subtract}) => {
  │ if (subtract(7, 3) !== 4) process.exit(1) })"
  └ (node:2) Warning: To load an ES module, set "type": "module" in the
    package.json or use the .mjs extension.
    … +15 lines

────────────────────────────────────────────────────────────────────────────

• Added and exported subtract(a, b) in math.js:5. Runtime check passed.

────────────────────────────────────────────────────────────────────────────
```

Rules, exactly:

| element | shape |
| --- | --- |
| user message | `› ` + text, blank line after |
| agent prose | `• ` + text, continuation lines at column 2 |
| command | `• Ran <command>`, continuation lines `  │ ` |
| command output | first line `  └ `, later lines `    ` (4 spaces) |
| file edit | `• Edited <path> (+a -d)` then numbered rows |
| diff row | `    <lineno> <sign><text>`; context uses two spaces after the number |
| elision | `    … +N lines` |
| turn boundary | a full-width `─` rule |

Only the **first** output line takes `└`. Everything after it aligns to the
same column with plain spaces, which is why the connector reads as a corner
rather than a bracket.

## Live status

One line, no spinner glyph:

```
• Working (22s • esc to interrupt)
```

The elapsed seconds tick; the hint after the middle dot is the only affordance
shown while a turn is running.

## Composer and footer

```
› Explain this codebase

  gpt-5.6-sol high · /tmp/claude-63735/…/scratchpad/codexbox
```

The placeholder is a **rotating example task**, dim, replaced on each idle
return (`Implement {feature}`, `Improve documentation in @filename`,
`Run /review on my current changes`, `Explain this codebase`). The footer is
one dim line: model, a middle dot, the working directory, truncated on the
right with `…`.

## Slash menu

Rows sit under the composer, name column padded to the longest entry:

```
› /go

  /model         choose what model and reasoning effort to use
  /fast          1.5x speed, increased usage
  /ide           include current selection, open files, and other context
  /permissions   choose what Codex is allowed to do
  /goal          set or view the goal for a long-running task
```

## Selection popup

Every modal choice — model, permissions, approvals — is the same list. The
selected row carries `›`; rows are numbered and directly selectable by digit.

```
  Select Model and Effort
  Access legacy models by running codex -m <model_name> or in your config.toml

› 1. gpt-5.6-sol (current)  Latest frontier agentic coding model.
  2. gpt-5.6-terra          Balanced agentic coding model for everyday work.
  3. gpt-5.6-luna           Fast and affordable agentic coding model.

  Press enter to confirm or esc to go back
```

Descriptions form a second column that wraps under itself rather than under
the label:

```
› 1. Ask for approval (current)  Codex can read and edit files in the current
                                 workspace, and run commands. Approval is
                                 required to access the internet.
```

## `/goal`

Menu entry: `set or view the goal for a long-running task`.

State, from `thread_goals`:

```sql
objective           TEXT
status              active | paused | blocked | usage_limited
                    | budget_limited | complete
token_budget        INTEGER NULL
tokens_used         INTEGER
time_used_seconds   INTEGER
```

Behaviour, from the embedded steering templates
(`goals/continuation.md`, `goals/budget_limit.md`, `goals/objective_updated.md`):

- The goal **persists across turns**. When a turn ends, the next turn is
  started automatically with "Continue working toward the active thread goal",
  carrying tokens used / budget / remaining.
- Ending a turn does not license shrinking the objective. "Keep the full
  objective intact. If it cannot be finished now, make concrete progress
  toward the real requested end state, leave the goal active, and do not
  redefine success around a smaller or easier task."
- The objective is **untrusted data**, wrapped in `<untrusted_objective>` —
  the task to pursue, not higher-priority instructions.
- Completion is gated by an audit: derive concrete requirements from the
  objective, find authoritative evidence for each, and treat uncertain or
  indirect evidence as not achieved. "The audit must prove completion, not
  merely fail to find obvious remaining work."
- `blocked` requires the **same** blocker three consecutive goal turns, and is
  never for work that is merely hard, slow, or incomplete.
- The model may only ever set `complete` or `blocked`. Pause, resume, and the
  budget/usage limits belong to the user and the runtime.
- A goal must not be marked complete because its budget ran out.

Sun's adaptation of the last point: the model reports a goal verdict on the
`complete` decision, and the session loop — not the model — decides whether
that ends the goal.
