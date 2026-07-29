import { glyph, tone, truncate, visibleWidth, wrap } from "./theme.ts";

/**
 * The one modal shape in the interface.
 *
 * Every choice Sun asks for — approving a command, switching model, changing
 * the approval policy — is this list. Rows are numbered so a digit selects
 * directly, and the description forms a second column that wraps under itself
 * rather than under the label.
 */

export interface SelectOption {
  label: string;
  description?: string;
  /** Renders a dim "(current)" marker after the label. */
  current?: boolean;
}

export interface SelectView {
  title: string;
  subtitle?: string;
  options: readonly SelectOption[];
  selected: number;
  /** Overrides the default confirm/cancel line. */
  hint?: string;
}

const DEFAULT_HINT = "Press enter to confirm or esc to go back";
/** Descriptions are dropped below this width and the labels stand alone. */
const MIN_DESCRIPTION_WIDTH = 24;

export function renderSelect(view: SelectView, width: number): string[] {
  const usable = Math.max(4, width);
  const labels = view.options.map(
    (option, index) =>
      `${index + 1}. ${option.label}${option.current ? " (current)" : ""}`,
  );
  const labelWidth = Math.max(...labels.map((label) => visibleWidth(label)));
  const descriptionColumn = labelWidth + 4;
  const descriptionWidth = usable - descriptionColumn - 2;
  const inline = descriptionWidth >= MIN_DESCRIPTION_WIDTH;

  const lines: string[] = ["", `  ${tone.heading(truncate(view.title, usable - 2))}`];
  if (view.subtitle) {
    lines.push(
      ...wrap(view.subtitle, usable - 2).map(
        (line) => `  ${tone.muted(line)}`,
      ),
    );
  }
  lines.push("");

  for (const [index, option] of view.options.entries()) {
    const active = index === view.selected;
    const marker = active ? tone.info(glyph.user) : " ";
    const label = labels[index] ?? "";
    const painted = active ? tone.selected(label) : label;

    if (!option.description) {
      lines.push(`${marker} ${truncate(painted, usable - 2)}`);
      continue;
    }
    if (!inline) {
      lines.push(`${marker} ${truncate(painted, usable - 2)}`);
      lines.push(
        ...wrap(option.description, usable - 6).map(
          (line) => `    ${tone.muted(line)}`,
        ),
      );
      continue;
    }
    const body = wrap(option.description, descriptionWidth);
    lines.push(
      truncate(
        `${marker} ${painted}${" ".repeat(Math.max(1, descriptionColumn - 2 - visibleWidth(label)))}${tone.muted(body[0] ?? "")}`,
        usable,
      ),
    );
    for (const line of body.slice(1)) {
      lines.push(
        truncate(`${" ".repeat(descriptionColumn)}${tone.muted(line)}`, usable),
      );
    }
  }

  lines.push("");
  lines.push(`  ${tone.muted(truncate(view.hint ?? DEFAULT_HINT, usable - 2))}`);
  return lines;
}

/**
 * Move the highlight. Wrapping keeps a short list navigable with one key
 * rather than two.
 */
export function moveSelection(
  selected: number,
  count: number,
  delta: number,
): number {
  if (count <= 0) return 0;
  return (selected + delta + count) % count;
}

/** The row a digit key selects, or null when it names no row. */
export function digitSelection(text: string, count: number): number | null {
  if (!/^[1-9]$/.test(text)) return null;
  const index = Number(text) - 1;
  return index < count ? index : null;
}
