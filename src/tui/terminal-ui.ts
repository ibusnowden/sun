import { parseGoalArguments, type Goal } from "../agent/goal.ts";
import type {
  ApprovalHandler,
  ApprovalRequest,
  EventSink,
  ModelUsage,
  TokenLedger,
  ProviderObserver,
  RunMode,
  RunResult,
  RuntimeEvent,
  ToolCall,
  ToolName,
  ToolResult,
  ToolUsage,
} from "../core/types.ts";
import type { PeriodTotal, UsageHistory } from "../agent/usage.ts";
import {
  isUsageView,
  renderActivity,
  usageFooter,
} from "./heatmap.ts";
import { listWorkspaceFiles } from "../repository/inspect.ts";
import { renderHeader, renderRule } from "./chrome.ts";
import { control, cursorToColumn, cursorUp } from "./theme.ts";
import {
  applyCompletion,
  completionContext,
  rankCandidates,
  SLASH_COMMANDS,
  type CompletionItem,
} from "./completion.ts";
import {
  KeyDecoder,
  LineEditor,
  renderFooter,
  type CompletionView,
  type FooterView,
  type Key,
} from "./live.ts";
import {
  digitSelection,
  moveSelection,
  type SelectOption,
  type SelectView,
} from "./select.ts";
import {
  pagerScroll,
  refitPager,
  renderPager,
  wrapPatch,
  type PagerMove,
  type PagerState,
} from "./pager.ts";
import {
  describeCall,
  emptyLedger,
  goalBadge,
  renderAssistant,
  renderError,
  renderFileList,
  renderGoalCard,
  renderHelp,
  renderInlineDiff,
  renderInterrupted,
  renderNarration,
  renderNote,
  renderPatch,
  renderTask,
  renderTokens,
  renderToolChange,
  renderToolEnd,
} from "./transcript.ts";

/** Sun's own take on Codex's rotating composer examples. */
const PLACEHOLDERS = [
  "Ask anything",
  "Explain this codebase",
  "Fix the failing test in @path",
  "Set a long task with /goal",
  "Review my working changes with /diff",
] as const;

const TIPS = [
  "Press esc while Sun works to interrupt at the next safe boundary.",
  "Use /goal to give Sun an objective that outlives a single answer.",
  "Type @ to complete a workspace path, / for a command.",
] as const;

/** Token spend that outlives the session, owned by the session loop. */
export interface UsageController {
  record(usage: ModelUsage): void;
  summary(): { week: PeriodTotal; month: PeriodTotal };
  /** The whole ledger, for the activity grid. */
  history(): UsageHistory;
}

/** Read a model list and switch the session onto one. */
export interface ModelController {
  current(): string;
  list(): Promise<string[]>;
  select(model: string): Promise<void>;
}

/** The persisted goal, owned by the session loop. */
export interface GoalController {
  current(): Goal | null;
  set(objective: string, tokenBudget: number | null): Promise<Goal>;
  clear(): Promise<void>;
  pause(): Promise<Goal | null>;
  resume(): Promise<Goal | null>;
}

export interface TerminalUIOptions {
  version: string;
  mode: RunMode;
  model: string;
  repository: string;
  /** Shown under the header in place of the rotating tip, when set. */
  notice?: string;
  /** Injectable sink for tests; defaults to the real terminal. */
  output?: { write(chunk: string): void };
  /** Injectable workspace listing for `@` completion; defaults to a real walk. */
  listFiles?: () => Promise<string[]>;
  /** Injectable working-tree diff for `/diff`; defaults to a real `git diff`. */
  workingDiff?: () => Promise<string>;
  /**
   * Whether this session may take the alternate screen. Defaults to the real
   * tty check, so a piped session prints the patch instead of paging it.
   */
  fullScreen?: () => boolean;
  models?: ModelController;
  usage?: UsageController;
  goal?: GoalController;
}

interface FileActivity {
  path: string;
  action: string;
  status: "running" | "ok" | "failed";
}

interface PendingSelect {
  view: SelectView;
  resolve: (index: number | null) => void;
}

const CTRL_C_EXIT_WINDOW_MS = 2_000;
/** Reasoning text kept in memory for the live window. */
const REASONING_BUFFER = 2_000;

/** Keys that change the buffer, and so revive a dismissed completion menu. */
const EDITING_KEYS = new Set<Key["name"]>([
  "char",
  "paste",
  "backspace",
  "delete",
  "kill-word",
]);

/**
 * Sun's interactive terminal. The transcript is written to normal scrollback so
 * a finished session stays readable, while a small live region at the bottom
 * carries streamed reasoning, the working row, the composer, and the status.
 */
export class TerminalUI implements ApprovalHandler {
  readonly #options: TerminalUIOptions;
  readonly #out: { write(chunk: string): void };
  readonly #editor = new LineEditor();
  readonly #decoder = new KeyDecoder();
  readonly #files = new Map<string, FileActivity>();

  #active = false;
  #busy = false;
  #exitRequested = false;
  #diffPatch = "";
  #changedFiles: string[] = [];
  #runStartedAt = Date.now();
  #toolStartedAt = 0;
  #pendingCall: ToolCall | null = null;
  #suppressNextInlineDiff = false;
  #totalTokens = 0;
  #ledger: TokenLedger = emptyLedger();
  /** Per-tool cost across the whole session; the registry is per-turn. */
  readonly #toolUsage = new Map<ToolName, ToolUsage>();
  #queued: string[] = [];
  #select: PendingSelect | null = null;
  /** Set only while the full-screen pager owns the alternate screen. */
  #pager: PagerState | null = null;
  /** Transcript produced while the pager is open, replayed when it closes. */
  #deferredWrites: string[] = [];
  /** "ask" stops at every command; "auto" runs them inside the sandbox. */
  #approvalMode: "ask" | "auto" = "ask";
  #mode: RunMode = "work";
  readonly #alwaysApproved = new Set<string>();
  #taskResolve: ((task: string | null) => void) | null = null;
  #pendingTask: string | null = null;
  #abort: AbortController | null = null;
  #interrupting = false;
  #wasInterrupted = false;
  #reasoning = "";
  #notice = "";
  #noticeTimer: ReturnType<typeof setTimeout> | null = null;
  #lastCtrlC = 0;
  #placeholder = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #keyFlushTimer: ReturnType<typeof setTimeout> | null = null;
  #liveRows = 0;
  #cursorRow = 0;
  #lastFrame = "";
  #completion: CompletionView | null = null;
  #completionDismissed = false;
  #fileCandidates: CompletionItem[] | null = null;
  #filesLoading = false;

  readonly #onData = (data: Buffer | string) => this.#feedTerminalKeys(data);
  readonly #onResize = () => {
    this.#lastFrame = "";
    if (this.#pager) {
      this.#renderPager();
      return;
    }
    this.#renderLive();
  };
  readonly #onExit = () => this.#restore();

  constructor(options: TerminalUIOptions) {
    this.#options = options;
    this.#out = options.output ?? process.stdout;
    this.#mode = options.mode;
  }

  get exitRequested(): boolean {
    return this.#exitRequested;
  }

  /** The mode the next turn runs in. */
  get mode(): RunMode {
    return this.#mode;
  }

  /** Cumulative session tokens, so the session loop can bill a goal turn. */
  get totalTokens(): number {
    return this.#totalTokens;
  }

  /** Runtime events from the agent loop. */
  readonly handle: EventSink = (event) => {
    this.#consume(event);
  };

  /** Model telemetry, wired into the provider. */
  readonly observer: ProviderObserver = {
    onPhaseStart: (phase) => this.#consume({ type: "model_start", phase }),
    onThinking: (phase, delta) =>
      this.#consume({ type: "thinking", phase, delta }),
    onPhaseEnd: (phase, info) =>
      this.#consume({ type: "model_end", phase, ...info }),
  };

  start(): void {
    if (this.#active) return;
    this.#active = true;
    this.#write(
      renderHeader(
        {
          name: "Sun",
          version: this.#options.version,
          model: this.#currentModel(),
          repository: this.#options.repository,
          ...(this.#options.notice ? { notice: this.#options.notice } : {}),
          tip: TIPS[Math.floor(Math.random() * TIPS.length)] ?? TIPS[0],
        },
        this.#width(),
      ),
    );
    process.once("exit", this.#onExit);
    process.stdout.on("resize", this.#onResize);
    this.#enableInput();
    // The working row shows elapsed seconds, so it has to repaint on a timer
    // even when no event has arrived.
    this.#timer = setInterval(() => {
      if (this.#busy) this.#renderLive();
    }, 500);
    this.#timer.unref();
    this.#renderLive();
  }

  stop(): void {
    if (!this.#active) return;
    this.#active = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#keyFlushTimer) clearTimeout(this.#keyFlushTimer);
    this.#keyFlushTimer = null;
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    this.#noticeTimer = null;
    process.stdout.off("resize", this.#onResize);
    process.off("exit", this.#onExit);
    this.#disableInput();
    this.#clearLive();
    this.#restore();
    this.#out.write("\n");
  }

  /** Resolves with the next task, or null when the user asked to exit. */
  async readTask(): Promise<string | null> {
    if (this.#exitRequested) return null;
    this.#busy = false;
    this.#placeholder = (this.#placeholder + 1) % PLACEHOLDERS.length;
    // A task queued between runs is never dropped on the floor. The test is
    // against null, not truthiness: a goal hand-off queues the empty string,
    // which means "pursue the active goal".
    if (this.#pendingTask !== null) {
      const task = this.#pendingTask;
      this.#pendingTask = null;
      return task;
    }
    this.#renderLive();
    return await new Promise<string | null>((resolve) => {
      this.#taskResolve = resolve;
    });
  }

  /**
   * `display` is what the transcript shows. A goal continuation sends the
   * model a long steering prompt but should read as one short line here.
   */
  beginRun(task: string, display?: string): AbortSignal {
    this.#busy = true;
    this.#files.clear();
    this.#diffPatch = "";
    this.#changedFiles = [];
    this.#suppressNextInlineDiff = false;
    this.#runStartedAt = Date.now();
    this.#interrupting = false;
    this.#wasInterrupted = false;
    this.#reasoning = "";
    this.#queued = [];
    this.#abort = new AbortController();
    this.#write(renderTask(display ?? task, this.#width()));
    this.#renderLive();
    return this.#abort.signal;
  }

  endRun(result: RunResult | null): void {
    const interrupted = this.#wasInterrupted;
    const width = this.#width();
    this.#busy = false;
    this.#abort = null;
    this.#interrupting = false;
    this.#pendingCall = null;
    this.#reasoning = "";
    this.#notice = "";
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    this.#noticeTimer = null;
    // A run can create or delete files, so the completion cache is rebuilt.
    this.#fileCandidates = null;
    if (result) {
      if (interrupted) {
        this.#write(
          renderInterrupted("partial response kept in context", width),
        );
      } else if (result.state === "blocked") {
        this.#write(renderError(result.summary, width));
      } else {
        this.#write(renderAssistant(result.summary, width));
      }
      this.#write([renderRule(width), ""]);
    }
    this.#renderLive();
  }

  note(message: string): void {
    this.#write(renderNote(message, this.#width()));
  }

  error(message: string): void {
    this.#write(renderError(message, this.#width()));
  }

  /** Print the goal card, used by the session loop when a goal settles. */
  showGoal(goal: Goal): void {
    this.#write(renderGoalCard(goal, this.#width()));
  }

  drainInput(): string[] {
    return this.#queued.splice(0);
  }

  /** The single entry point for terminal input; also used by tests. */
  feedKeys(raw: string): void {
    for (const key of [...this.#decoder.feed(raw), ...this.#decoder.flush()]) {
      this.#handleKey(key);
    }
  }

  #feedTerminalKeys(raw: Buffer | string): void {
    if (this.#keyFlushTimer) clearTimeout(this.#keyFlushTimer);
    this.#keyFlushTimer = null;
    for (const key of this.#decoder.feed(raw)) this.#handleKey(key);
    this.#keyFlushTimer = setTimeout(() => {
      this.#keyFlushTimer = null;
      for (const key of this.#decoder.flush()) this.#handleKey(key);
    }, 20);
    this.#keyFlushTimer.unref();
  }

  async confirm(request: ApprovalRequest): Promise<boolean> {
    if (!this.#active) return false;
    const scope = approvalScope(request);
    // An `alwaysAsk` request leaves the sandbox, so neither auto mode nor a
    // remembered answer may stand in for the user.
    if (
      !request.alwaysAsk &&
      (this.#approvalMode === "auto" || this.#alwaysApproved.has(scope))
    ) {
      this.#toolStartedAt = Date.now();
      return true;
    }
    const command = request.command ?? request.action.replace(/^[^:]+:\s*/, "");
    const choices: ReadonlyArray<{
      label: string;
      id: "yes" | "always" | "steer";
    }> = [
      { label: request.alwaysAsk ? "Yes, publish it" : "Yes, run it", id: "yes" },
      ...(request.alwaysAsk
        ? []
        : ([
            {
              label: `Yes, and stop asking about ${scope} this session`,
              id: "always",
            },
          ] as const)),
      { label: "No, and let me steer instead", id: "steer" },
    ];
    const choice = await this.#choose({
      title: request.alwaysAsk
        ? "Allow Sun to publish outside the sandbox?"
        : "Allow Sun to run this command?",
      subtitle: command,
      ...(request.detail ? { detail: request.detail } : {}),
      options: choices.map(({ label }) => ({ label })),
      hint: request.alwaysAsk
        ? "Press enter to confirm, esc to cancel. Sun asks every time."
        : "Press enter to confirm, esc to skip the command",
    });
    const picked = choice === null ? null : choices[choice]?.id;
    if (picked === "always") this.#alwaysApproved.add(scope);
    if (picked === "steer") {
      this.#editor.set(`Use this instead of \`${command}\`: `);
    }
    // Approval wait is human time, not command runtime.
    this.#toolStartedAt = Date.now();
    return picked === "yes" || picked === "always";
  }

  // ---------------------------------------------------------------- events

  #consume(event: RuntimeEvent): void {
    const width = this.#width();
    switch (event.type) {
      case "model_start":
        this.#reasoning = "";
        break;
      case "thinking":
        // Codex shows the model thinking as it happens. Only the tail is kept:
        // this is a window onto the stream, and the narration bullet written
        // at tool_start is what actually survives into scrollback.
        this.#reasoning = `${this.#reasoning}${event.delta}`.slice(
          -REASONING_BUFFER,
        );
        break;
      case "model_end":
        this.#recordUsage(event.usage);
        break;
      case "tool_start":
        this.#pendingCall = event.call;
        this.#toolStartedAt = Date.now();
        this.#reasoning = "";
        this.#trackFile(event.call, "running");
        this.#write(renderNarration(event.call.rationale, width));
        break;
      case "tool_end": {
        this.#recordTool(event.call.tool, event.result);
        // One blank row closes the whole block, so an edit reads as a headline
        // with its diff attached rather than two separate events.
        this.#write([
          ...renderToolEnd(
            event.call,
            event.result,
            width,
            this.#toolStartedAt ? Date.now() - this.#toolStartedAt : undefined,
          ),
          ...renderToolChange(event.call, event.result, width),
          "",
        ]);
        this.#suppressNextInlineDiff =
          event.result.ok &&
          (event.call.tool === "edit" || event.call.tool === "write");
        this.#trackFile(event.call, event.result.ok ? "ok" : "failed");
        this.#pendingCall = null;
        break;
      }
      case "diff":
        if (
          !this.#suppressNextInlineDiff &&
          event.patch.trim() &&
          event.patch !== this.#diffPatch
        ) {
          this.#write([...renderInlineDiff(event.patch, width), ""]);
        }
        this.#suppressNextInlineDiff = false;
        this.#diffPatch = event.patch;
        this.#changedFiles = event.files;
        break;
      case "approval":
        break;
      case "interrupted":
        this.#wasInterrupted = true;
        break;
    }
    this.#renderLive();
  }

  #recordUsage(usage: ModelUsage | null): void {
    if (!usage) return;
    this.#options.usage?.record(usage);
    this.#totalTokens += usage.totalTokens;
    this.#ledger = {
      calls: this.#ledger.calls + 1,
      promptTokens: this.#ledger.promptTokens + usage.promptTokens,
      completionTokens: this.#ledger.completionTokens + usage.completionTokens,
      totalTokens: this.#totalTokens,
      last: usage,
      peakPromptTokens: Math.max(
        this.#ledger.peakPromptTokens,
        usage.promptTokens,
      ),
      // A provider that reports 0 does not know its window; keep the last
      // real number rather than overwriting it with a non-answer.
      contextTokens: usage.contextTokens || this.#ledger.contextTokens,
    };
  }

  /**
   * The registry measures each result; a registry lives for one turn, so the
   * session-wide view is accumulated from the stamped figure here.
   */
  #recordTool(tool: ToolName, result: ToolResult): void {
    const entry = this.#toolUsage.get(tool) ?? {
      tool,
      calls: 0,
      failures: 0,
      truncated: 0,
      outputTokens: 0,
    };
    this.#toolUsage.set(tool, {
      tool,
      calls: entry.calls + 1,
      failures: entry.failures + (result.ok ? 0 : 1),
      truncated: entry.truncated + (result.truncated ? 1 : 0),
      outputTokens: entry.outputTokens + (result.outputTokens ?? 0),
    });
  }

  #trackFile(call: ToolCall, status: FileActivity["status"]): void {
    const path = filePath(call.tool, call.input);
    if (!path) return;
    this.#files.set(path, { path, action: call.tool, status });
  }

  // ------------------------------------------------------------------ keys

  #handleKey(key: Key): void {
    if (this.#pager) {
      this.#handlePagerKey(key);
      return;
    }
    if (this.#select) {
      this.#handleSelectKey(key);
      return;
    }
    if (this.#completion && this.#handleCompletionKey(key)) {
      this.#renderLive();
      return;
    }
    // Any edit re-opens a menu the user dismissed with escape.
    if (EDITING_KEYS.has(key.name)) this.#completionDismissed = false;
    switch (key.name) {
      case "char":
      case "paste":
        this.#editor.insert(key.text);
        break;
      case "enter":
        this.#submit();
        break;
      case "newline":
        this.#editor.insert("\n");
        break;
      case "backspace":
        this.#editor.backspace();
        break;
      case "delete":
        this.#editor.delete();
        break;
      case "left":
        this.#editor.move(-1);
        break;
      case "right":
        this.#editor.move(1);
        break;
      case "up":
        this.#editor.previous();
        break;
      case "down":
        this.#editor.next();
        break;
      case "home":
        this.#editor.home();
        break;
      case "end":
        this.#editor.end();
        break;
      case "kill-line":
        this.#editor.killLine();
        break;
      case "kill-word":
        this.#editor.killWord();
        break;
      case "clear-screen":
        this.#clearScreen();
        break;
      case "escape":
        this.#escape();
        break;
      case "interrupt":
        this.#interrupt();
        break;
      case "eof":
        if (!this.#editor.value) this.#requestExit();
        break;
      case "tab":
      case "unknown":
        break;
    }
    this.#refreshCompletion();
    this.#renderLive();
  }

  // ---------------------------------------------------------------- select

  /** Open a modal choice and resolve with the chosen index, or null on esc. */
  async #choose(view: Omit<SelectView, "selected">): Promise<number | null> {
    if (!this.#active || view.options.length === 0) return null;
    const choice = await new Promise<number | null>((resolve) => {
      this.#select = { view: { ...view, selected: 0 }, resolve };
      this.#renderLive();
    });
    this.#select = null;
    this.#renderLive();
    return choice;
  }

  #handleSelectKey(key: Key): void {
    const pending = this.#select;
    if (!pending) return;
    const count = pending.view.options.length;
    switch (key.name) {
      case "up":
        pending.view = {
          ...pending.view,
          selected: moveSelection(pending.view.selected, count, -1),
        };
        break;
      case "down":
        pending.view = {
          ...pending.view,
          selected: moveSelection(pending.view.selected, count, 1),
        };
        break;
      case "enter":
        pending.resolve(pending.view.selected);
        return;
      case "escape":
        pending.resolve(null);
        return;
      case "interrupt":
        pending.resolve(null);
        this.#interrupt();
        return;
      case "char": {
        const index = digitSelection(key.text, count);
        if (index !== null) {
          pending.resolve(index);
          return;
        }
        break;
      }
      default:
        break;
    }
    this.#renderLive();
  }

  // ----------------------------------------------------------------- pager

  /**
   * `/diff` reads the working tree at the moment it is asked, not the patch
   * the last turn happened to report. Those differ whenever the user edits a
   * file themselves, or asks before Sun has run anything at all — and the
   * question "what has changed here" is about the tree, not about the turn.
   */
  async #diffCommand(): Promise<void> {
    const read = this.#options.workingDiff;
    let patch = this.#diffPatch;
    if (read) {
      try {
        patch = await read();
      } catch (error) {
        // Reporting a clean tree here would be a lie: Git could not read the
        // workspace at all. Show why, rather than an empty pager.
        this.#write(
          renderNote(
            `Could not read the working tree: ${(error as Error).message}`,
            this.#width(),
          ),
        );
        return;
      }
    }
    this.#openPager("diff", patch);
  }

  /**
   * Take the alternate screen. The live region is erased first so the pager
   * does not inherit a half-drawn composer, and the transcript underneath is
   * restored untouched when the pager closes.
   */
  #openPager(title: string, content: string): void {
    const canPage =
      this.#options.fullScreen?.() ?? Boolean(process.stdin.isTTY);
    if (!this.#active || !canPage) {
      this.#write(renderPatch(content, this.#width()));
      return;
    }
    this.#clearLive();
    const width = this.#screenWidth();
    this.#pager = {
      title,
      source: content,
      rows: wrapPatch(content, width),
      wrappedWidth: width,
      offset: 0,
    };
    this.#out.write(control.enterAlternate + control.hideCursor);
    this.#renderPager();
  }

  #closePager(): void {
    if (!this.#pager) return;
    this.#pager = null;
    this.#out.write(control.exitAlternate + control.showCursor);
    this.#lastFrame = "";
    this.#liveRows = 0;
    this.#cursorRow = 0;
    const deferred = this.#deferredWrites;
    this.#deferredWrites = [];
    // #write redraws the live region itself, so only an empty flush needs it.
    if (deferred.length) this.#write(deferred);
    else this.#renderLive(true);
  }

  #handlePagerKey(key: Key): void {
    const pager = this.#pager;
    if (!pager) return;
    const moves: Partial<Record<Key["name"], PagerMove>> = {
      up: "up",
      down: "down",
      "page-up": "page-up",
      "page-down": "page-down",
      home: "home",
      end: "end",
    };
    // `j`/`k` ride alongside the arrows, exactly as Codex leaves them: the
    // jump and half-page motions a vim user would reach for next are not bound.
    const move =
      moves[key.name] ??
      (key.name === "char"
        ? key.text === "j"
          ? "down"
          : key.text === "k"
            ? "up"
            : undefined
        : undefined);
    if (move) {
      pager.offset = pagerScroll(pager, move, this.#rows());
      this.#renderPager();
      return;
    }
    if (key.name === "escape" || (key.name === "char" && key.text === "q")) {
      this.#closePager();
      return;
    }
    if (key.name === "interrupt") {
      this.#closePager();
      this.#interrupt();
    }
  }

  #renderPager(): void {
    const pager = this.#pager;
    if (!pager) return;
    const width = this.#screenWidth();
    // A resize changes where every long line breaks, so the body is rebuilt
    // rather than reflowed, and the offset is re-clamped by the renderer.
    refitPager(pager, width);
    // Each row is placed absolutely. Joining with newlines would leave a row
    // that exactly fills the width in the terminal's pending-wrap state, and
    // the frame would drift down the screen by a line on every keystroke.
    const frame = renderPager(pager, width, this.#rows())
      .map((line, index) => `\x1b[${index + 1};1H${control.eraseLine}${line}`)
      .join("");
    this.#out.write(control.syncStart + frame + control.syncEnd);
  }

  // ------------------------------------------------------------ completion

  /** Returns true when the open menu consumed the key. */
  #handleCompletionKey(key: Key): boolean {
    const menu = this.#completion;
    if (!menu) return false;
    const count = menu.items.length;
    switch (key.name) {
      case "up":
        this.#completion = {
          ...menu,
          selected: moveSelection(menu.selected, count, -1),
        };
        return true;
      case "down":
        this.#completion = {
          ...menu,
          selected: moveSelection(menu.selected, count, 1),
        };
        return true;
      case "tab":
        this.#acceptCompletion();
        return true;
      case "enter": {
        // A fully typed token means the user is done choosing: let the key
        // through so one enter submits instead of two.
        const context = completionContext(
          this.#editor.value,
          this.#editor.cursor,
        );
        if (context && menu.items[menu.selected]?.value === context.query) {
          this.#completion = null;
          this.#completionDismissed = true;
          return false;
        }
        this.#acceptCompletion();
        return true;
      }
      case "escape":
        this.#completion = null;
        this.#completionDismissed = true;
        return true;
      default:
        return false;
    }
  }

  #acceptCompletion(): void {
    const menu = this.#completion;
    const context = completionContext(this.#editor.value, this.#editor.cursor);
    const item = menu?.items[menu.selected];
    if (!menu || !context || !item) return;
    const next = applyCompletion(
      this.#editor.value,
      this.#editor.cursor,
      context,
      item,
    );
    this.#editor.replace(next.value, next.cursor);
    // Accepting settles the token: the menu stays shut until the next edit,
    // rather than reopening on the exact match that was just chosen.
    this.#completion = null;
    this.#completionDismissed = true;
  }

  #refreshCompletion(): void {
    const context = this.#completionDismissed
      ? null
      : completionContext(this.#editor.value, this.#editor.cursor);
    if (!context) {
      this.#completion = null;
      return;
    }
    if (context.trigger === "/") {
      const items = rankCandidates(SLASH_COMMANDS, context.query);
      this.#completion = items.length
        ? { trigger: "/", items, selected: 0 }
        : null;
      return;
    }
    this.#ensureFileCandidates();
    const items = rankCandidates(this.#fileCandidates ?? [], context.query);
    this.#completion = items.length
      ? { trigger: "@", items, selected: 0 }
      : null;
  }

  /**
   * The workspace walk is deferred until the first `@` and then cached for the
   * rest of the run, so an idle session never pays for it.
   */
  #ensureFileCandidates(): void {
    if (this.#fileCandidates || this.#filesLoading) return;
    this.#filesLoading = true;
    const list =
      this.#options.listFiles ??
      (() => listWorkspaceFiles(this.#options.repository));
    void list()
      .then((paths) => {
        this.#fileCandidates = paths.map((path) => ({ value: path, detail: "" }));
      })
      .catch(() => {
        this.#fileCandidates = [];
      })
      .finally(() => {
        this.#filesLoading = false;
        this.#refreshCompletion();
        this.#renderLive();
      });
  }

  #submit(): void {
    const value = this.#editor.submit();
    this.#completion = null;
    this.#completionDismissed = false;
    if (!value) return;
    if (value.startsWith("/")) {
      void this.#runCommand(value);
      return;
    }
    if (this.#busy) {
      this.#queued.push(value);
      this.#write(renderTask(value, this.#width()));
      return;
    }
    const resolve = this.#taskResolve;
    this.#taskResolve = null;
    if (resolve) {
      resolve(value);
      return;
    }
    this.#pendingTask = value;
  }

  #escape(): void {
    if (this.#editor.value) {
      this.#editor.killLine();
      return;
    }
    if (this.#busy) this.#interruptRun();
  }

  #interrupt(): void {
    if (this.#editor.value) {
      this.#editor.killLine();
      return;
    }
    if (this.#busy) {
      this.#interruptRun();
      return;
    }
    const now = Date.now();
    if (now - this.#lastCtrlC < CTRL_C_EXIT_WINDOW_MS) {
      this.#requestExit();
      return;
    }
    this.#lastCtrlC = now;
    this.#setNotice("press ctrl+c again to exit");
  }

  #interruptRun(): void {
    if (this.#interrupting) return;
    this.#interrupting = true;
    this.#setNotice("interrupting at the next safe boundary…");
    this.#abort?.abort();
  }

  #requestExit(): void {
    this.#exitRequested = true;
    this.#abort?.abort();
    this.#select?.resolve(null);
    const resolve = this.#taskResolve;
    this.#taskResolve = null;
    resolve?.(null);
  }

  #setNotice(message: string): void {
    this.#notice = message;
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    this.#noticeTimer = setTimeout(() => {
      this.#notice = "";
      this.#renderLive();
    }, 2_500);
    this.#noticeTimer.unref?.();
  }

  // -------------------------------------------------------------- commands

  async #runCommand(raw: string): Promise<void> {
    const [command = ""] = raw.slice(1).split(/\s+/);
    const argument = raw.slice(1 + command.length).trim();
    const width = this.#width();
    switch (command.toLowerCase()) {
      case "help":
      case "?":
        this.#write(renderHelp(width));
        break;
      case "goal":
        await this.#goalCommand(argument);
        break;
      case "model":
        await this.#modelCommand();
        break;
      case "approvals":
        await this.#approvalsCommand();
        break;
      case "plan":
        this.#planCommand();
        break;
      case "usage": {
        // Bare `/usage` is the grid, because that is what the name promises.
        // The session ledger is one of its views, not a separate command.
        const requested = argument.trim().toLowerCase() || "daily";
        if (!isUsageView(requested)) {
          this.#write(
            renderNote(
              `Unknown view "${requested}". Try /usage session, daily, weekly, or cumulative.`,
              width,
            ),
          );
          break;
        }
        if (requested === "session") {
          this.#write([
            ...renderTokens(
              {
                ledger: this.#ledger,
                tools: [...this.#toolUsage.values()].sort(
                  (left, right) => right.outputTokens - left.outputTokens,
                ),
                periods: this.#options.usage?.summary() ?? null,
              },
              width,
            ),
            // Carries the same footer as the grid, so the other three views
            // are reachable from here rather than only from the grid.
            usageFooter("session"),
            "",
          ]);
          break;
        }
        const history = this.#options.usage?.history();
        this.#write(
          history
            ? renderActivity(history, requested, width)
            : renderNote("Activity history needs an interactive session.", width),
        );
        break;
      }
      case "diff":
        await this.#diffCommand();
        break;
      case "files":
        this.#write(renderFileList([...this.#files.values()], width));
        break;
      case "clear":
        this.#clearScreen();
        break;
      case "quit":
      case "exit":
        this.#requestExit();
        break;
      default:
        this.#write(
          renderNote(`Unknown command /${command}. Try /help.`, width),
        );
    }
  }

  async #goalCommand(argument: string): Promise<void> {
    const goals = this.#options.goal;
    const width = this.#width();
    if (!goals) {
      this.#write(renderNote("Goals need an interactive session.", width));
      return;
    }
    // A sub-command has to be the whole argument. "/goal clear the caches" is
    // an objective about caches, not a request to forget the goal.
    const action = argument.toLowerCase();
    if (!argument) {
      const current = goals.current();
      this.#write(
        current
          ? renderGoalCard(current, width)
          : renderNote(
              "No goal is set. Use /goal <objective> to start one.",
              width,
            ),
      );
      return;
    }
    if (action === "clear" || action === "stop") {
      await goals.clear();
      this.#write(renderNote("Goal cleared.", width));
      return;
    }
    if (action === "pause") {
      const paused = await goals.pause();
      this.#write(
        paused
          ? renderGoalCard(paused, width)
          : renderNote("No goal is set.", width),
      );
      return;
    }
    if (action === "resume") {
      const resumed = await goals.resume();
      if (!resumed) {
        this.#write(renderNote("No goal is set.", width));
        return;
      }
      this.#write(renderGoalCard(resumed, width));
      // Resuming has to actually restart the loop, not just repaint the card.
      this.#deliverTask("");
      return;
    }
    const { objective, tokenBudget } = parseGoalArguments(argument);
    if (!objective) {
      this.#write(renderNote("A goal needs an objective.", width));
      return;
    }
    const goal = await goals.set(objective, tokenBudget);
    this.#write(renderGoalCard(goal, width));
    this.#deliverTask("");
  }

  /**
   * Hand the session loop an empty task, which it reads as "a goal is active,
   * start pursuing it".
   */
  #deliverTask(task: string): void {
    const resolve = this.#taskResolve;
    this.#taskResolve = null;
    if (resolve) resolve(task);
    else this.#pendingTask = task;
  }

  async #modelCommand(): Promise<void> {
    const models = this.#options.models;
    const width = this.#width();
    if (!models) {
      this.#write(renderNote("Model switching needs an interactive session.", width));
      return;
    }
    this.#setNotice("loading models…");
    const available = await models.list().catch(() => [] as string[]);
    this.#notice = "";
    if (available.length === 0) {
      this.#write(
        renderNote("The endpoint reported no models. Try sun doctor.", width),
      );
      return;
    }
    const current = models.current();
    const options: SelectOption[] = available.map((model) => ({
      label: model,
      ...(model === current ? { current: true } : {}),
    }));
    const choice = await this.#choose({
      title: "Select model",
      subtitle: "Sun keeps the conversation and switches the model for the next turn.",
      options,
    });
    const picked = choice === null ? null : available[choice];
    if (!picked || picked === current) return;
    await models.select(picked);
    this.#write(renderNote(`Model set to ${picked}.`, width));
  }

  #planCommand(): void {
    this.#mode = this.#mode === "plan" ? "work" : "plan";
    this.#write(
      renderNote(
        this.#mode === "plan"
          ? "Plan mode. Sun investigates and proposes; edits, writes, and publishing are refused until you approve a plan."
          : "Work mode. Sun can change the workspace again.",
        this.#width(),
      ),
    );
  }

  /** Offered after a plan-mode turn so the user can hand the plan back. */
  async confirmPlan(): Promise<"run" | "revise" | "keep"> {
    const choice = await this.#choose({
      title: "Run this plan?",
      subtitle:
        "Approving switches Sun to work mode and carries out the plan above.",
      options: [
        { label: "Yes, carry it out" },
        {
          label: "No, revise the plan",
          description: "Stay in plan mode and tell Sun what to change",
        },
        {
          label: "No, keep planning on my own",
          description: "Stay in plan mode and leave the plan unrun",
        },
      ],
      hint: "Press enter to confirm, esc to keep planning",
    });
    if (choice === 0) {
      this.#mode = "work";
      return "run";
    }
    if (choice === 1) {
      this.#editor.set("Revise the plan: ");
      return "revise";
    }
    return "keep";
  }

  async #approvalsCommand(): Promise<void> {
    const choice = await this.#choose({
      title: "Update command approvals",
      subtitle:
        "Every command runs inside the Bubblewrap sandbox either way; this only changes whether Sun stops to ask first.",
      options: [
        {
          label: "Ask every time",
          description:
            "Sun pauses at each command and shows it before anything runs.",
          ...(this.#approvalMode === "ask" ? { current: true } : {}),
        },
        {
          label: "Run without asking",
          description:
            "Commands go straight to the sandbox. Sun still cannot reach the network or leave the workspace.",
          ...(this.#approvalMode === "auto" ? { current: true } : {}),
        },
      ],
    });
    if (choice === null) return;
    this.#approvalMode = choice === 1 ? "auto" : "ask";
    this.#write(
      renderNote(
        this.#approvalMode === "auto"
          ? "Sun will run sandboxed commands without asking."
          : "Sun will ask before every command.",
        this.#width(),
      ),
    );
  }

  #currentModel(): string {
    return this.#options.models?.current() ?? this.#options.model;
  }

  // -------------------------------------------------------------- terminal

  #clearScreen(): void {
    this.#out.write(control.clearScreen);
    this.#liveRows = 0;
    this.#cursorRow = 0;
    this.#lastFrame = "";
  }

  #width(): number {
    const columns = process.stdout.columns ?? 80;
    return Math.max(12, columns - 1);
  }

  /** Full screen height. The pager owns every row, unlike the live region. */
  #rows(): number {
    return Math.max(8, process.stdout.rows ?? 24);
  }

  /**
   * The live region stops one column short so a full-width line cannot wrap
   * under the composer. The pager positions every row absolutely instead, so
   * it can use the last column the way the reference does.
   */
  #screenWidth(): number {
    return Math.max(12, process.stdout.columns ?? 80);
  }

  #enableInput(): void {
    if (!process.stdin.isTTY) return;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", this.#onData);
    this.#out.write("\x1b[?2004h");
  }

  #disableInput(): void {
    if (!process.stdin.isTTY) return;
    this.#out.write("\x1b[?2004l");
    process.stdin.off("data", this.#onData);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  #restore(): void {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    // Exiting mid-pager must hand the normal screen back, or the shell prompt
    // returns onto the alternate buffer and the session appears to vanish.
    const alternate = this.#pager ? control.exitAlternate : "";
    this.#pager = null;
    this.#out.write(`\x1b[?2004l${alternate}${control.showCursor}`);
    // Exiting straight out of the pager must not swallow the transcript the
    // run produced behind it.
    const deferred = this.#deferredWrites;
    this.#deferredWrites = [];
    if (deferred.length) this.#out.write(`${deferred.join("\n")}\n`);
  }

  #write(lines: string[]): void {
    if (!this.#active || lines.length === 0) return;
    // A turn keeps running while the pager is open. The alternate screen is
    // discarded on exit, so anything written onto it would be lost from the
    // transcript entirely — hold it until the real screen is back.
    if (this.#pager) {
      this.#deferredWrites.push(...lines);
      return;
    }
    this.#clearLive();
    this.#out.write(`${lines.join("\n")}\n`);
    this.#renderLive(true);
  }

  /** The sequence that removes the live region, so a caller can batch it. */
  #eraseLive(): string {
    if (this.#liveRows === 0) return "";
    const sequence =
      control.lineStart + cursorUp(this.#cursorRow) + control.eraseDown;
    this.#liveRows = 0;
    this.#cursorRow = 0;
    return sequence;
  }

  #clearLive(): void {
    const sequence = this.#eraseLive();
    if (sequence) this.#out.write(sequence);
  }

  #renderLive(force = false): void {
    if (!this.#active) return;
    // The pager owns the whole screen; a composer drawn over it would land on
    // the alternate buffer and survive as garbage once the pager closes.
    if (this.#pager) return;
    const frame = renderFooter(this.#view(), this.#width());
    const maxRows = Math.max(4, (process.stdout.rows ?? 24) - 1);
    const lines = frame.lines.slice(-maxRows);
    const cursorRow = frame.cursorRow - (frame.lines.length - lines.length);
    const signature = `${lines.join("\n")}|${cursorRow}|${frame.cursorColumn}`;
    if (!force && signature === this.#lastFrame) return;
    this.#lastFrame = signature;

    const up = Math.max(0, lines.length - 1 - cursorRow);
    this.#out.write(
      control.syncStart +
        control.hideCursor +
        this.#eraseLive() +
        lines.join("\n") +
        control.lineStart +
        cursorUp(up) +
        cursorToColumn(frame.cursorColumn) +
        (this.#select ? "" : control.showCursor) +
        control.syncEnd,
    );
    this.#liveRows = lines.length;
    this.#cursorRow = Math.max(0, cursorRow);
  }

  #view(): FooterView {
    const goal = this.#options.goal?.current() ?? null;
    return {
      busy: this.#busy,
      activity: "",
      elapsedMs: this.#busy
        ? this.#pendingCall
          ? Date.now() - this.#toolStartedAt
          : Date.now() - this.#runStartedAt
        : 0,
      totalTokens: this.#totalTokens,
      model: this.#currentModel(),
      mode: this.#mode,
      repository: this.#options.repository,
      input: this.#editor.value,
      cursor: this.#editor.cursor,
      activeTool: this.#pendingCall
        ? {
            name: this.#pendingCall.tool,
            target: describeCall(this.#pendingCall),
          }
        : null,
      notice: this.#notice,
      completion: this.#completion,
      reasoning: this.#reasoning,
      select: this.#select?.view ?? null,
      placeholder: PLACEHOLDERS[this.#placeholder] ?? PLACEHOLDERS[0],
      ...(goal ? { goal: goalBadge(goal) } : {}),
    };
  }
}

function filePath(
  tool: ToolName,
  input: Record<string, unknown>,
): string | null {
  if (tool === "read" || tool === "edit" || tool === "write") {
    return typeof input.path === "string" ? input.path : null;
  }
  return null;
}

function approvalScope(request: ApprovalRequest): string {
  return request.action.split(":")[0]?.trim().toLowerCase() || "action";
}
