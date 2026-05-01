/**
 * Terminal rendering — markdown-aware narration + styled banners.
 *
 * DM narration is piped through `marked` + `marked-terminal` so that
 * light markdown (italics, bold, lists) the model emits gets ANSI
 * styling. The harness's own output (banners, status lines, dividers,
 * warnings) uses `chalk` directly with consistent palette below.
 *
 * Colors auto-disable when stdout is not a TTY (chalk handles this), so
 * piped output / CI / test runs stay clean.
 */

import chalk from "chalk";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

let configured = false;

function configureMarked(): void {
  if (configured) return;
  marked.use(
    markedTerminal({
      // Distinct colors for emphasis so the model can use **bold** to
      // highlight player choices / proper nouns / important objects, and
      // *italic* for atmospheric / internal-sense beats. We don't reflow
      // text — narration paragraphs are already short.
      reflowText: false,
      width: Math.min(process.stdout.columns ?? 80, 100),
      paragraph: chalk.reset,
      em: chalk.italic.magenta,            // *italic* — magenta + italic
      strong: chalk.bold.yellow,           // **bold** — yellow + bold
      codespan: chalk.green,               // `code` — green (distinct from bold)
      blockquote: chalk.dim.italic.cyan,
      heading: chalk.bold.cyan,
      listitem: chalk.reset,
      hr: chalk.dim,
      del: chalk.strikethrough.red,
      link: chalk.blue.underline,
      href: chalk.blue.underline,
    }) as unknown as Parameters<typeof marked.use>[0],
  );
  configured = true;
}

/** Render a chunk of markdown to ANSI-styled text. Trailing newline trimmed. */
export function renderMarkdown(md: string): string {
  if (!md) return "";
  configureMarked();
  // marked.parse is async-or-sync depending on extensions; use parseSync via cast.
  const out = marked.parse(md, { async: false }) as string;
  return out.replace(/\n+$/, "");
}

// ---------------------------------------------------------------------
// Styled fragments — consistent palette across the CLI.
// ---------------------------------------------------------------------

export const style = {
  /** Subtle bracketed status line, e.g. [turn 3/22 · health=10]. */
  status(text: string): string {
    return chalk.dim(text);
  },
  /** Harness asides — "(saved slot ...)" "(loaded slot ...)" etc. */
  aside(text: string): string {
    return chalk.dim.italic(text);
  },
  /** Errors / warnings the player sees. */
  warn(text: string): string {
    return chalk.yellow(text);
  },
  error(text: string): string {
    return chalk.red(text);
  },
  /** Win / lose dividers. */
  win(text: string): string {
    return chalk.green.bold(text);
  },
  lose(text: string): string {
    return chalk.red.bold(text);
  },
  /** Section headings inside meta-command output. */
  heading(text: string): string {
    return chalk.bold.cyan(text);
  },
  /** Field label inside the banner ("THEME:", "GOAL:"). */
  label(text: string): string {
    return chalk.bold.cyan(text);
  },
  /** The player's prompt arrow. */
  prompt(text: string): string {
    return chalk.bold.green(text);
  },
};

/**
 * Build a boxed banner for the opening scenario card. Uses Unicode
 * box-drawing characters; falls back gracefully on terminals without
 * good Unicode support (most modern terms handle it).
 */
export function openingBanner(opts: {
  theme: string;
  setting?: string | null;
  premise?: string | null;
  goal?: string | null;
  turnLimit?: number | null;
}): string {
  const width = Math.min(process.stdout.columns ?? 80, 80);
  const inner = width - 4;
  const lines: string[] = [];
  const top = chalk.cyan("╔" + "═".repeat(width - 2) + "╗");
  const bot = chalk.cyan("╚" + "═".repeat(width - 2) + "╝");
  const sep = chalk.cyan("║ ") + chalk.dim("─".repeat(inner)) + chalk.cyan(" ║");

  const pad = (s: string): string => {
    // visible length of `s` may differ from string length due to ANSI;
    // we measure unstyled length here. Caller is responsible for not
    // injecting raw ANSI into this function's payloads.
    const visible = stripAnsi(s);
    const padding = Math.max(0, inner - visible.length);
    return chalk.cyan("║ ") + s + " ".repeat(padding) + chalk.cyan(" ║");
  };

  const wrap = (label: string, body: string): string[] => {
    const head = `${style.label(label.toUpperCase() + ":")} `;
    const indent = " ".repeat(label.length + 2);
    const wrapped = wrapText(body, inner - (label.length + 2));
    if (wrapped.length === 0) return [];
    const out: string[] = [];
    out.push(pad(head + wrapped[0]));
    for (let i = 1; i < wrapped.length; i++) out.push(pad(indent + wrapped[i]));
    return out;
  };

  lines.push(top);
  lines.push(...wrap("theme", opts.theme));
  if (opts.setting) lines.push(...wrap("setting", opts.setting));
  if (opts.premise) {
    lines.push(sep);
    for (const w of wrapText(opts.premise, inner)) lines.push(pad(w));
  }
  if (opts.goal) {
    lines.push(sep);
    lines.push(...wrap("goal", opts.goal));
  }
  if (opts.turnLimit != null) lines.push(...wrap("turn limit", String(opts.turnLimit)));
  lines.push(bot);
  return lines.join("\n");
}

/** Big WIN / LOSE divider for the run's end. */
export function endingBanner(outcome: "won" | { lost: string }): string {
  const width = Math.min(process.stdout.columns ?? 80, 80);
  const bar = "═".repeat(width);
  if (outcome === "won") {
    const label = "  ★  YOU WIN  ★  ";
    const pad = " ".repeat(Math.max(0, Math.floor((width - label.length) / 2)));
    return [chalk.green(bar), chalk.green.bold(pad + label), chalk.green(bar)].join("\n");
  }
  const label = `  YOU LOSE — ${outcome.lost}  `;
  const pad = " ".repeat(Math.max(0, Math.floor((width - label.length) / 2)));
  return [chalk.red(bar), chalk.red.bold(pad + label), chalk.red(bar)].join("\n");
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Greedy word wrap to a given visible width. Newlines preserved. */
function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n/)) {
    if (para.length <= width) {
      out.push(para);
      continue;
    }
    const words = para.split(/\s+/);
    let line = "";
    for (const w of words) {
      if (!line.length) line = w;
      else if (line.length + 1 + w.length <= width) line += " " + w;
      else {
        out.push(line);
        line = w;
      }
    }
    if (line) out.push(line);
  }
  return out;
}
