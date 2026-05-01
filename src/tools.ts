/**
 * DM tool dispatch.
 *
 * Five tools the DM uses to drive the world:
 *
 *   world_query(goal)   — read-only Prolog query
 *   world_assert(code)  — append-only lore (location/3, exit/3, item_def/4,
 *                         character_def/4, fact/3)
 *   state_set(code)     — mutate state via :- assertz / :- retract /
 *                         :- retractall on the dynamic predicates declared
 *                         in schema.pl
 *   narrate(text)       — emit prose to the player
 *   end_turn()          — finalize the turn; harness then runs invariants
 *
 * Validators on world_assert / state_set keep the lore/state boundary
 * crisp: lore can never be retracted, and state mutations can never
 * touch the lore predicates. This is the "stable world" guarantee.
 */

import type { ChatToolDef } from "./llm.js";
import type { PrologSession } from "./prolog.js";

export const LORE_PREDS = new Set([
  "location",
  "exit",
  "item_def",
  "character_def",
  "fact",
  // Scenario lore — asserted at worldgen, never mutated during play.
  "scenario",
  "victory",
  "defeat",
]);

export const STATE_PREDS = new Set([
  "player_at",
  "player_has",
  "at",
  "visited",
  "npc_state",
  "flag",
  "condition",
  "told",
  "item_state",
  "holds",
  "turn_count",
  "event_log",
  // Roguelike state.
  "player_stat",
  "game_status",
  "turn_limit",
]);

/** Decorate every world_assert tempfile with multifile decls so SWI's
 *  consult-replaces-clauses behaviour doesn't fire (and doesn't emit
 *  "Redefined static procedure" warnings to stderr). */
const MULTIFILE_LORE_HEADER = `:- multifile location/3, exit/3, item_def/4, character_def/4, fact/3, scenario/3, victory/0, defeat/1.
`;

export const TOOL_SCHEMAS: ChatToolDef[] = [
  {
    type: "function",
    function: {
      name: "world_query",
      description:
        "Run a Prolog goal against the world KB and return all answers (capped at 1000). Read-only — use this freely to ground your narration in facts. Examples: 'player_at(L)', 'visible_item(I), item_def(I, N, _, _)', 'exit_here(D, To)'.",
      parameters: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description:
              "A Prolog goal. No surrounding ?- or trailing dot needed.",
          },
        },
        required: ["goal"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world_assert",
      description:
        "Append append-only lore. ONLY these clause heads are allowed: location/3, exit/3, item_def/4, character_def/4, fact/3. No directives (:- ...). No retracts. Use this when the player enters uncharted territory or you need to introduce new items / NPCs / lore facts.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "One or more Prolog clauses, each ending in a period. Example: \"location(crypt, 'Damp Crypt', 'A low stone vault...'). exit(crypt, up, cottage_cellar). exit(cottage_cellar, down, crypt). item_def(skull, 'yellowed skull', 'It grins back at you.', [takeable]).\"",
          },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "state_set",
      description:
        "Mutate world state via Prolog directives. Each statement MUST be a directive (:- ...) using assertz/1, retract/1, or retractall/1 on one of the dynamic state predicates: player_at, player_has, at, visited, npc_state, flag, condition, told, item_state, holds, turn_count, event_log. Use this to move the player, take/drop items, set flags, layer location conditions, track NPC conversations via told/2, update item properties via item_state/2, manage container contents via holds/2, advance npc_state, increment turn_count, and append event_log entries. Never use this to touch lore predicates.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "One or more directives. Example: \":- retractall(player_at(_)), assertz(player_at(crypt)). :- assertz(visited(crypt)). :- assertz(condition(yard, 'rain has soaked the timbers')).\"",
          },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "narrate",
      description:
        "Emit prose to the player. Terse, atmospheric, second-person. Should ground every detail in a fact you can defend with world_query. Don't repeat the canonical location description verbatim on a normal look — paraphrase, weaving in any active condition/2 layers and what's currently here.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "end_turn",
      description:
        "Finalize this turn. Call exactly once per player command, AFTER you've made all needed assertions / state changes / narrated. The harness then runs invariant checks; if any fail, you'll be asked to retry.",
      parameters: { type: "object", properties: {} },
    },
  },
];

// ---------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------
//
// We split Prolog source on top-level periods (respecting nesting and
// quoted atoms/strings), then inspect each statement's leading head.

interface Statement {
  text: string;
  isDirective: boolean;
  /** For non-directive clauses, the leading functor name. Null for directives
   *  (their bodies are validated by splitDirectiveSegments instead). */
  head: string | null;
}

function splitStatements(src: string): { statements: Statement[]; error: string | null } {
  const statements: Statement[] = [];
  let buf = "";
  let depth = 0;
  let inSingle = false; // 'atom or string'
  let inDouble = false; // "string"
  let inLineComment = false;

  const flush = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    statements.push(parseStatement(trimmed));
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1] ?? "";

    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      buf += c;
      continue;
    }
    if (!inSingle && !inDouble && c === "%") {
      inLineComment = true;
      buf += c;
      continue;
    }
    if (inSingle) {
      buf += c;
      if (c === "\\" && next) {
        buf += next;
        i++;
        continue;
      }
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      buf += c;
      if (c === "\\" && next) {
        buf += next;
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      buf += c;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      buf += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      buf += c;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth < 0) {
        return { statements, error: `unbalanced "${c}"` };
      }
      buf += c;
      continue;
    }
    if (c === "." && depth === 0 && !/[A-Za-z0-9_]/.test(next) && next !== ".") {
      // End of statement; consume the dot but don't append it back.
      flush(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  if (depth !== 0) return { statements, error: "unbalanced parens" };
  if (inSingle || inDouble) return { statements, error: "unterminated quote" };
  if (buf.trim()) {
    return { statements, error: `trailing input without terminating period: "${buf.trim().slice(0, 60)}"` };
  }
  return { statements, error: null };
}

function parseStatement(text: string): Statement {
  if (/^\s*:-/.test(text)) {
    return { text, isDirective: true, head: null };
  }
  const headMatch = text.match(/^([a-z][a-zA-Z0-9_]*)/);
  return { text, isDirective: false, head: headMatch ? headMatch[1] : null };
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export function validateLore(code: string): ValidationResult {
  const { statements, error } = splitStatements(code);
  if (error) return { ok: false, error: `parse error: ${error}` };
  if (!statements.length) return { ok: false, error: "world_assert: empty code" };
  for (const s of statements) {
    if (s.isDirective) {
      return {
        ok: false,
        error:
          "world_assert: directives (:- ...) are not allowed. Provide bare clauses only, e.g. \"location(id, 'Name', 'Desc').\"",
      };
    }
    if (!s.head) {
      return { ok: false, error: `world_assert: cannot identify clause head in "${s.text.slice(0, 60)}"` };
    }
    if (!LORE_PREDS.has(s.head)) {
      return {
        ok: false,
        error: `world_assert: head "${s.head}" is not a lore predicate. Allowed: ${[...LORE_PREDS].sort().join(", ")}.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Split a directive body on TOP-LEVEL commas (depth 0, outside quotes).
 * `retractall(player_at(_)), assertz(player_at(crypt))` →
 *   ["retractall(player_at(_))", "assertz(player_at(crypt))"]
 */
function splitDirectiveSegments(body: string): string[] {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  let inS = false, inD = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    const prev = body[i - 1];
    if (inS) {
      buf += c;
      if (c === "'" && prev !== "\\") inS = false;
      continue;
    }
    if (inD) {
      buf += c;
      if (c === '"' && prev !== "\\") inD = false;
      continue;
    }
    if (c === "'") { inS = true; buf += c; continue; }
    if (c === '"') { inD = true; buf += c; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; buf += c; continue; }
    if (c === ")" || c === "]" || c === "}") { depth--; buf += c; continue; }
    if (c === "," && depth === 0) {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

export function validateStateSet(code: string): ValidationResult {
  const { statements, error } = splitStatements(code);
  if (error) return { ok: false, error: `parse error: ${error}` };
  if (!statements.length) return { ok: false, error: "state_set: empty code" };
  for (const s of statements) {
    if (!s.isDirective) {
      return {
        ok: false,
        error:
          "state_set: every statement must be a directive of the form ':- assertz(...). ' or ':- retractall(...). ' or ':- retract(...).'",
      };
    }
    const body = s.text.replace(/^\s*:-\s*/, "").replace(/\.$/, "").trim();
    if (!body) {
      return { ok: false, error: `state_set: empty directive "${s.text.slice(0, 80)}"` };
    }
    // Top-level segments: each must be an assertz/retract/retractall call.
    // Nothing else is permitted — no is/2, no arithmetic, no side-effecting
    // calls. This blocks the model from writing
    // ":- retractall(turn_count(_)), turn_count is 1, X is turn_count+1, ..."
    // which Prolog would silently fail mid-way and leave the KB partially mutated.
    const segments = splitDirectiveSegments(body);
    if (segments.length === 0) {
      return {
        ok: false,
        error: `state_set: directive body is empty: "${s.text.slice(0, 80)}"`,
      };
    }
    for (const seg of segments) {
      const wrapMatch = seg.match(/^(assertz|asserta|assert|retract|retractall)\s*\(/);
      if (!wrapMatch) {
        return {
          ok: false,
          error: `state_set: every directive segment must be assertz(...), retract(...), or retractall(...). Got: "${seg.slice(0, 80)}". To compute a new value (e.g. turn_count + 1), first world_query the current value, then state_set with the literal new value.`,
        };
      }
      const wrapper = wrapMatch[1];
      if (wrapper === "assert" || wrapper === "asserta") {
        return {
          ok: false,
          error: `state_set: use "assertz" instead of "${wrapper}" so save-file ordering stays deterministic`,
        };
      }
      // Find inner term and check head.
      const inner = seg.slice(wrapMatch[0].length, -1).trim(); // drop final ')'
      const headMatch = inner.match(/^([a-z][a-zA-Z0-9_]*)/);
      const head = headMatch ? headMatch[1] : null;
      if (!head) {
        return {
          ok: false,
          error: `state_set: cannot identify wrapped predicate head in "${seg.slice(0, 80)}"`,
        };
      }
      if (!STATE_PREDS.has(head)) {
        return {
          ok: false,
          error: `state_set: predicate "${head}" is not mutable. Mutable preds: ${[...STATE_PREDS].sort().join(", ")}. (Lore predicates are append-only and must go through world_assert.)`,
        };
      }
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------

export interface ToolContext {
  session: PrologSession;
  /** Narration emitted by the model this turn (multiple narrate calls accumulate). */
  narrations: string[];
  /** Set true when end_turn fires. */
  endRequested: boolean;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export async function executeTool(
  name: string,
  argsJson: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  let args: Record<string, unknown>;
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return { content: `tool args were not valid JSON: ${argsJson.slice(0, 200)}`, isError: true };
  }

  switch (name) {
    case "world_query": {
      const goal = String(args.goal ?? "").trim();
      if (!goal) return { content: "world_query: missing 'goal'", isError: true };
      const r = await ctx.session.query(goal);
      if (r.status !== "success") return { content: `error: ${r.error}`, isError: true };
      if (r.answers.length === 0) return { content: "no answers (goal failed)" };
      const lines = r.answers.slice(0, 50).map((a) => a.formatted);
      const more =
        r.answers.length > 50 ? `\n(+ ${r.answers.length - 50} more answers)` : "";
      return { content: `${r.answers.length} answer(s):\n${lines.join("\n")}${more}` };
    }
    case "world_assert": {
      const code = String(args.code ?? "");
      const v = validateLore(code);
      if (!v.ok) return { content: v.error!, isError: true };
      // Prepend multifile decls so SWI accumulates clauses across the
      // many world_assert tempfiles instead of emitting "Redefined static
      // procedure" warnings (which are cosmetically loud, even though
      // schema.pl's :- multifile declarations cause clauses to be kept).
      const decorated = MULTIFILE_LORE_HEADER + code;
      const r = await ctx.session.assert(decorated);
      if (r.status !== "ok") return { content: `prolog error: ${r.error}`, isError: true };
      return { content: "ok" };
    }
    case "state_set": {
      const code = String(args.code ?? "");
      const v = validateStateSet(code);
      if (!v.ok) return { content: v.error!, isError: true };
      const r = await ctx.session.assert(code);
      if (r.status !== "ok") return { content: `prolog error: ${r.error}`, isError: true };
      return { content: "ok" };
    }
    case "narrate": {
      const text = String(args.text ?? "").trim();
      if (!text) return { content: "narrate: missing 'text'", isError: true };
      ctx.narrations.push(text);
      return { content: "narration recorded" };
    }
    case "end_turn": {
      ctx.endRequested = true;
      return { content: "turn ended" };
    }
    default:
      return { content: `unknown tool "${name}"`, isError: true };
  }
}
