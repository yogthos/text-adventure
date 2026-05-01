/**
 * Save / load — `.pl` persistence for the world model.
 *
 * Per slot we write two files under `saves/<slot>/`:
 *   - lore.pl   : append-only world data (location/3, exit/3, item_def/4,
 *                 character_def/4, fact/3, scenario/3). Rewritten each
 *                 turn from current KB; the file's contents are
 *                 monotonic-by-design because the DM is forbidden from
 *                 retracting lore.
 *   - state.pl  : mutable state (player_at, player_has, at, visited,
 *                 npc_state, flag, condition, turn_count, event_log,
 *                 player_stat, game_status, turn_limit). Rewritten each turn.
 *
 * NOTE: rule-shaped lore (victory/0 and defeat/1, which the DM defines
 * during worldgen) is NOT preserved across save/load — the dumper here
 * only round-trips facts. Roguelike runs are designed as single-process
 * sessions (permadeath), so this is intentional. If you /save-and-resume
 * a roguelike run in a fresh process, you'll lose the win/lose rules.
 *
 * Both files are simple `pred(args).` clauses. Loading order is always:
 *   schema.pl  →  lore.pl  →  state.pl
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { PrologSession } from "./prolog.js";
import { consultFile, loadSchema } from "./world.js";

const SAVES_ROOT = resolve("saves");

interface PredSpec {
  name: string;
  arity: number;
}

const LORE_PREDS: PredSpec[] = [
  { name: "location", arity: 3 },
  { name: "exit", arity: 3 },
  { name: "item_def", arity: 4 },
  { name: "character_def", arity: 4 },
  { name: "fact", arity: 3 },
  { name: "scenario", arity: 3 },
  // victory/0 and defeat/1 are typically RULES, not facts — the snapshot
  // dumper here doesn't round-trip them. See module header.
];

const STATE_PREDS: PredSpec[] = [
  { name: "player_at", arity: 1 },
  { name: "player_has", arity: 1 },
  { name: "at", arity: 2 },
  { name: "visited", arity: 1 },
  { name: "npc_state", arity: 2 },
  { name: "flag", arity: 1 },
  { name: "condition", arity: 2 },
  { name: "turn_count", arity: 1 },
  { name: "event_log", arity: 2 },
  { name: "player_stat", arity: 2 },
  { name: "game_status", arity: 1 },
  { name: "turn_limit", arity: 1 },
];

function slotDir(slot: string): string {
  return resolve(SAVES_ROOT, slot);
}

export function slotExists(slot: string): boolean {
  return existsSync(resolve(slotDir(slot), "lore.pl"));
}

export async function listSlots(): Promise<string[]> {
  if (!existsSync(SAVES_ROOT)) return [];
  const entries = await readdir(SAVES_ROOT, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && existsSync(resolve(SAVES_ROOT, e.name, "lore.pl")))
    .map((e) => e.name)
    .sort();
}

/** Generate `Var0, Var1, ...` placeholder names for a goal of given arity. */
function placeholders(arity: number): string[] {
  return Array.from({ length: arity }, (_, i) => `V${i}`);
}

/** Pull every clause for a predicate as a list of pre-rendered clause strings. */
async function dumpPredicate(
  session: PrologSession,
  spec: PredSpec,
): Promise<string[]> {
  const vars = placeholders(spec.arity);
  const goal =
    spec.arity === 0 ? spec.name : `${spec.name}(${vars.join(", ")})`;
  const r = await session.query(goal);
  if (r.status !== "success") return [];
  return r.answers.map((ans) => {
    const args = vars.map((v) => ans.bindings[v]).join(", ");
    return spec.arity === 0 ? `${spec.name}.` : `${spec.name}(${args}).`;
  });
}

async function dumpSection(
  session: PrologSession,
  preds: PredSpec[],
  header: string,
): Promise<string> {
  const out: string[] = [header, ""];
  for (const spec of preds) {
    const clauses = await dumpPredicate(session, spec);
    if (!clauses.length) continue;
    out.push(`% ${spec.name}/${spec.arity}`);
    for (const c of clauses) out.push(c);
    out.push("");
  }
  return out.join("\n");
}

export async function saveGame(session: PrologSession, slot: string): Promise<void> {
  const dir = slotDir(slot);
  await mkdir(dir, { recursive: true });
  const lore = await dumpSection(
    session,
    LORE_PREDS,
    "% =====================================================================\n% Auto-saved lore. Append-only by design — the DM never retracts these.\n% =====================================================================",
  );
  const state = await dumpSection(
    session,
    STATE_PREDS,
    "% =====================================================================\n% Auto-saved mutable state. Rewritten each turn.\n% =====================================================================",
  );
  await writeFile(resolve(dir, "lore.pl"), lore);
  await writeFile(resolve(dir, "state.pl"), state);
}

/**
 * Load a saved slot into a (presumed-fresh) session: schema → lore → state.
 * Throws if the slot doesn't exist.
 */
export async function loadGame(session: PrologSession, slot: string): Promise<void> {
  if (!slotExists(slot)) {
    throw new Error(`save slot "${slot}" not found at ${slotDir(slot)}`);
  }
  await loadSchema(session);
  await consultFile(session, resolve(slotDir(slot), "lore.pl"));
  await consultFile(session, resolve(slotDir(slot), "state.pl"));
}

/** Convenience: schema + seed, the "new game" path. */
export async function newGame(session: PrologSession, seedPath: string): Promise<void> {
  await loadSchema(session);
  await consultFile(session, seedPath);
}

// Re-exported only so callers can resolve the saves dir consistently.
export { SAVES_ROOT };
