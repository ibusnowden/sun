import { createInterface } from "node:readline/promises";
import type {
  ApprovalHandler,
  ApprovalRequest,
  EventSink,
  ProviderObserver,
  RunResult,
} from "../core/types.ts";
import { describeCall, diffStats } from "./transcript.ts";
import { sanitizeTerminalText } from "./theme.ts";

/** Line-oriented output for CI, pipes, and `--plain`. No cursor control. */
export class PlainUI implements ApprovalHandler {
  readonly handle: EventSink = (event) => {
    switch (event.type) {
      case "model_start":
        console.log("[model] working");
        break;
      case "thinking":
        break;
      case "model_end":
        console.log(
          `[model] ${event.phase} ${event.failed ? "failed" : "done"} in ${Math.round(event.durationMs / 100) / 10}s${
            event.usage
              ? ` · ${event.usage.promptTokens} prompt / ${event.usage.completionTokens} completion tokens`
              : ""
          }`,
        );
        break;
      case "tool_start":
        console.log(
          sanitizeTerminalText(
            `[tool] ${event.call.tool} ${describeCall(event.call)} — ${event.call.rationale}`,
          ),
        );
        break;
      case "tool_end":
        console.log(
          sanitizeTerminalText(
            `[${event.result.ok ? "ok" : "failed"}] ${event.result.summary}`,
          ),
        );
        break;
      case "diff": {
        const stats = diffStats(event.patch);
        console.log(
          `[diff] ${event.files.length} file(s), +${stats.additions} -${stats.deletions}`,
        );
        break;
      }
      case "approval":
        console.log(sanitizeTerminalText(`[approval] ${event.action}`));
        break;
      case "interrupted":
        console.log(sanitizeTerminalText(`[interrupted] ${event.reason}`));
        break;
    }
  };

  readonly observer: ProviderObserver = {};

  async confirm(request: ApprovalRequest): Promise<boolean> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    console.log(
      sanitizeTerminalText(`${request.action}\n${request.reason}`),
    );
    if (request.command) {
      console.log(sanitizeTerminalText(`$ ${request.command}`));
    }
    const reader = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await reader.question("Approve? [y/N] ");
    reader.close();
    return /^(?:y|yes)$/i.test(answer.trim());
  }

  summarize(result: RunResult): void {
    console.log(
      sanitizeTerminalText(
        `\n${result.state.toUpperCase()}: ${result.summary}`,
      ),
    );
    if (result.filesChanged.length) {
      console.log(
        sanitizeTerminalText(`Files: ${result.filesChanged.join(", ")}`),
      );
    }
  }
}
