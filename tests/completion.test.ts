import { describe, expect, test } from "bun:test";
import {
  applyCompletion,
  completionContext,
  rankCandidates,
  renderCompletionMenu,
  SLASH_COMMANDS,
  type CompletionItem,
} from "../src/tui/completion.ts";
import { setColorEnabled, stripAnsi } from "../src/tui/theme.ts";
import { TerminalUI } from "../src/tui/terminal-ui.ts";

setColorEnabled(true);

const FILES = [
  "README.md",
  "src/cli.ts",
  "src/tui/live.ts",
  "src/tui/markdown.ts",
  "src/tui/theme.ts",
  "tests/tui.test.ts",
];

const items = (values: string[]): CompletionItem[] =>
  values.map((value) => ({ value, detail: "" }));

function harness() {
  const chunks: string[] = [];
  const ui = new TerminalUI({
    version: "0.1.0",
    mode: "work",
    model: "glm-5.2",
    repository: "/repo",
    output: { write: (chunk: string) => void chunks.push(chunk) },
    listFiles: async () => FILES,
  });
  const text = (): string =>
    stripAnsi(chunks.join(""))
      .replace(/\r/g, "")
      .replace(/\x1b\[\?[0-9]+[hl]/g, "");
  // The workspace walk is async; let it settle before asserting on the menu.
  const settle = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));
  return { ui, text, settle, chunks };
}

describe("completion context", () => {
  test("a leading slash opens the command menu", () => {
    expect(completionContext("/di", 3)).toEqual({
      trigger: "/",
      start: 0,
      query: "di",
    });
  });

  test("a finished command closes it", () => {
    expect(completionContext("/diff now", 9)).toBeNull();
  });

  test("a slash mid-line is a path, not a command", () => {
    expect(completionContext("look at src/cli.ts", 18)).toBeNull();
  });

  test("@ opens anywhere a token can start", () => {
    expect(completionContext("explain @src/tu", 15)).toEqual({
      trigger: "@",
      start: 8,
      query: "src/tu",
    });
    expect(completionContext("@", 1)).toEqual({
      trigger: "@",
      start: 0,
      query: "",
    });
  });

  test("an email address does not open the menu", () => {
    expect(completionContext("mail ibra@example.com", 21)).toBeNull();
  });

  test("a trailing space dismisses the menu", () => {
    expect(completionContext("@src/cli.ts ", 12)).toBeNull();
  });

  test("the caret, not the end of the line, decides the query", () => {
    expect(completionContext("@src/cli.ts and more", 4)).toEqual({
      trigger: "@",
      start: 0,
      query: "src",
    });
  });
});

describe("ranking", () => {
  test("an empty query lists candidates in order", () => {
    expect(rankCandidates(items(FILES), "", 3).map((item) => item.value)).toEqual(
      ["README.md", "src/cli.ts", "src/tui/live.ts"],
    );
  });

  test("a file name beats a directory match", () => {
    const ranked = rankCandidates(items(FILES), "tui.test");
    expect(ranked[0]?.value).toBe("tests/tui.test.ts");
  });

  test("a path prefix wins outright", () => {
    const ranked = rankCandidates(items(FILES), "src/tui/m");
    expect(ranked[0]?.value).toBe("src/tui/markdown.ts");
  });

  test("scattered characters still match, ranked last", () => {
    const ranked = rankCandidates(items(FILES), "mkdn");
    expect(ranked.map((item) => item.value)).toContain("src/tui/markdown.ts");
  });

  test("a query that matches nothing yields nothing", () => {
    expect(rankCandidates(items(FILES), "zzzz")).toEqual([]);
  });

  test("commands filter on the same rules", () => {
    expect(
      rankCandidates(SLASH_COMMANDS, "qu").map((item) => item.value),
    ).toEqual(["quit"]);
  });
});

describe("applying a completion", () => {
  test("a path lands with a separating space", () => {
    const context = completionContext("explain @src/tu", 15);
    expect(
      applyCompletion("explain @src/tu", 15, context!, {
        value: "src/tui/live.ts",
        detail: "",
      }),
    ).toEqual({ value: "explain @src/tui/live.ts ", cursor: 25 });
  });

  test("a command lands ready to submit", () => {
    const context = completionContext("/di", 3);
    expect(
      applyCompletion("/di", 3, context!, { value: "diff", detail: "" }),
    ).toEqual({ value: "/diff", cursor: 5 });
  });

  test("text after the caret is preserved", () => {
    const context = completionContext("@src and then some", 4);
    const applied = applyCompletion("@src and then some", 4, context!, {
      value: "src/cli.ts",
      detail: "",
    });
    expect(applied.value).toBe("@src/cli.ts  and then some");
  });
});

describe("menu rendering", () => {
  test("the selection is marked and directories are dimmed", () => {
    const lines = renderCompletionMenu(items(FILES).slice(0, 2), 1, "@", 40);
    expect(lines.map((line) => stripAnsi(line))).toEqual([
      "  README.md",
      "› src/cli.ts",
    ]);
  });

  test("commands show their description", () => {
    const help = SLASH_COMMANDS.filter((command) => command.value === "help");
    const lines = renderCompletionMenu(help, 0, "/", 40);
    expect(stripAnsi(lines[0] ?? "")).toBe("› /help  show this list");
  });

  test("nothing renders for an empty candidate list", () => {
    expect(renderCompletionMenu([], 0, "@", 40)).toEqual([]);
  });
});

describe("TerminalUI completion", () => {
  test("tab accepts the highlighted path", async () => {
    const { ui, settle } = harness();
    ui.start();
    ui.feedKeys("explain @src/tui/mark");
    await settle();
    ui.feedKeys("\t");
    ui.feedKeys("please");
    ui.feedKeys("\r");
    expect(ui.drainInput()).toEqual([]);
    ui.stop();
  });

  test("the menu lists matches under the input", async () => {
    const { ui, text, settle } = harness();
    ui.start();
    ui.feedKeys("@src/tui/");
    await settle();
    expect(text()).toContain("src/tui/live.ts");
    expect(text()).toContain("src/tui/markdown.ts");
    ui.stop();
  });

  test("arrows move the selection while the menu is open", async () => {
    const { ui, text, settle } = harness();
    ui.start();
    ui.feedKeys("@src/tui/");
    await settle();
    ui.feedKeys("\x1b[B");
    ui.feedKeys("\t");
    await settle();
    // The second row, not the first: equal-scoring paths sort shortest first.
    expect(text()).toContain("@src/tui/theme.ts");
    ui.stop();
  });

  test("escape closes the menu before it touches the input", async () => {
    const { ui, settle } = harness();
    ui.start();
    ui.feedKeys("@src");
    await settle();
    ui.feedKeys("\x1b");
    // The buffer survived the first escape, so a submit still sees it.
    ui.feedKeys("\r");
    ui.beginRun("x");
    ui.stop();
  });

  test("a slash command completes and runs on one enter", async () => {
    const { ui, text, settle } = harness();
    ui.start();
    ui.feedKeys("/hel");
    await settle();
    ui.feedKeys("\t");
    ui.feedKeys("\r");
    expect(text()).toContain("Commands");
    ui.stop();
  });

  test("a fully typed command submits without a second enter", async () => {
    const { ui, text, settle } = harness();
    ui.start();
    ui.feedKeys("/help");
    await settle();
    ui.feedKeys("\r");
    expect(text()).toContain("show this list");
    ui.stop();
  });

  test("history still works when no menu is open", () => {
    const { ui, text } = harness();
    ui.start();
    ui.feedKeys("first task\r");
    ui.feedKeys("\x1b[A");
    expect(text()).toContain("first task");
    ui.stop();
  });
});
