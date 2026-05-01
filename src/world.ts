/**
 * World query helpers — typed wrappers around Prolog goals that the
 * CLI and DM loop both use. Each helper takes the session and returns
 * structured data so callers don't need to parse bindings themselves.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrologSession } from "./prolog.js";
import { unq } from "./prolog.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCHEMA_PATH = resolve(HERE, "schema.pl");

export interface LocationView {
  id: string;
  shortName: string;
  longDesc: string;
  conditions: string[];
  exits: { direction: string; to: string; known: boolean }[];
  items: { id: string; name: string; desc: string; tags: string[] }[];
  npcs: { id: string; name: string; desc: string }[];
  visited: boolean;
}

/** Read the schema file off disk and consult it into the session. */
export async function loadSchema(session: PrologSession): Promise<void> {
  const code = readFileSync(SCHEMA_PATH, "utf8");
  const r = await session.assert(code);
  if (r.status === "error") {
    throw new Error(`failed to load schema: ${r.error}`);
  }
}

/** Consult an arbitrary .pl file (seeds, save files, model-generated lore). */
export async function consultFile(
  session: PrologSession,
  path: string,
): Promise<void> {
  const code = readFileSync(path, "utf8");
  const r = await session.assert(code);
  if (r.status === "error") {
    throw new Error(`failed to consult ${path}: ${r.error}`);
  }
}

/** Run a goal and return one binding per answer, or [] on no solutions / error. */
async function findAll(
  session: PrologSession,
  goal: string,
): Promise<Record<string, string>[]> {
  const r = await session.query(goal);
  if (r.status !== "success") return [];
  return r.answers.map((a) => a.bindings);
}

/** True if the goal has at least one solution. */
async function succeeds(session: PrologSession, goal: string): Promise<boolean> {
  const rows = await findAll(session, goal);
  return rows.length > 0;
}

/** Single-binding helper — returns the first answer's bindings, or null. */
async function findOne(
  session: PrologSession,
  goal: string,
): Promise<Record<string, string> | null> {
  const rows = await findAll(session, goal);
  return rows[0] ?? null;
}

export async function getPlayerLoc(session: PrologSession): Promise<string | null> {
  const row = await findOne(session, "player_at(L)");
  return row ? unq(row.L) : null;
}

export async function getInventory(
  session: PrologSession,
): Promise<{ id: string; name: string; desc: string; tags: string[] }[]> {
  const rows = await findAll(
    session,
    "player_has(I), item_def(I, N, D, T)",
  );
  return rows.map((b) => ({
    id: unq(b.I),
    name: unq(b.N),
    desc: unq(b.D),
    tags: parseList(b.T),
  }));
}

function parseList(term: string): string[] {
  // termToProlog renders lists as `[a, b, c]`. Strip brackets, split on
  // top-level commas. Tags are bare atoms so we don't need a real parser.
  const inner = term.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!inner) return [];
  return inner.split(",").map((s) => unq(s.trim()));
}

/** Pull the full structured view of the player's current location. */
export async function describeCurrent(
  session: PrologSession,
): Promise<LocationView | null> {
  const locId = await getPlayerLoc(session);
  if (!locId) return null;
  return describeLocation(session, locId);
}

export async function describeLocation(
  session: PrologSession,
  locId: string,
): Promise<LocationView | null> {
  const locRow = await findOne(
    session,
    `location('${locId}', N, D)`,
  );
  if (!locRow) return null;

  const condRows = await findAll(session, `condition('${locId}', C)`);
  const conditions = condRows.map((b) => unq(b.C));

  const exitRows = await findAll(
    session,
    `exit('${locId}', Dir, To)`,
  );
  const exits: LocationView["exits"] = [];
  for (const b of exitRows) {
    const to = unq(b.To);
    const known = await succeeds(session, `location('${to}', _, _)`);
    exits.push({ direction: unq(b.Dir), to, known });
  }

  const itemRows = await findAll(
    session,
    `at(I, '${locId}'), item_def(I, N, D, T)`,
  );
  const items = itemRows.map((b) => ({
    id: unq(b.I),
    name: unq(b.N),
    desc: unq(b.D),
    tags: parseList(b.T),
  }));

  const npcRows = await findAll(
    session,
    `at(C, '${locId}'), character_def(C, N, D, _)`,
  );
  const npcs = npcRows.map((b) => ({
    id: unq(b.C),
    name: unq(b.N),
    desc: unq(b.D),
  }));

  const visited = await succeeds(session, `visited('${locId}')`);

  return {
    id: locId,
    shortName: unq(locRow.N),
    longDesc: unq(locRow.D),
    conditions,
    exits,
    items,
    npcs,
    visited,
  };
}

/** Mark the current location visited (idempotent). */
export async function markVisited(session: PrologSession, locId: string): Promise<void> {
  // assertz only if not already visited, to avoid duplicate clauses.
  const seen = await succeeds(session, `visited('${locId}')`);
  if (!seen) {
    await session.assert(`:- assertz(visited('${locId}')).`);
  }
}

/** Move the player. Caller must have verified the exit exists + dest is known. */
export async function movePlayer(session: PrologSession, toLocId: string): Promise<void> {
  await session.assert(
    `:- retractall(player_at(_)), assertz(player_at('${toLocId}')).`,
  );
}

/** Pick up a takeable item from the current location. */
export async function takeItem(
  session: PrologSession,
  itemId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const can = await succeeds(session, `takeable_item('${itemId}')`);
  if (!can) return { ok: false, reason: "you can't take that" };
  await session.assert(
    `:- retract(at('${itemId}', _)), assertz(player_has('${itemId}')).`,
  );
  return { ok: true };
}

/** Drop an item from inventory into the current room. */
export async function dropItem(
  session: PrologSession,
  itemId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const has = await succeeds(session, `player_has('${itemId}')`);
  if (!has) return { ok: false, reason: "you aren't carrying that" };
  const loc = await getPlayerLoc(session);
  if (!loc) return { ok: false, reason: "no current location" };
  await session.assert(
    `:- retract(player_has('${itemId}')), assertz(at('${itemId}', '${loc}')).`,
  );
  return { ok: true };
}

/** Format a location view as Zork-style narration. */
export function formatLocation(v: LocationView): string {
  const parts: string[] = [];
  parts.push(`-- ${v.shortName} --`);
  parts.push(v.longDesc);
  if (v.conditions.length) {
    parts.push("");
    for (const c of v.conditions) parts.push(`(${c})`);
  }
  if (v.items.length) {
    parts.push("");
    parts.push(`You see: ${v.items.map((i) => i.name).join(", ")}.`);
  }
  if (v.npcs.length) {
    parts.push("");
    parts.push(
      v.npcs
        .filter((n) => n.name.length > 0)
        .map((n) => `${n.name[0].toUpperCase() + n.name.slice(1)} is here.`)
        .join(" "),
    );
  }
  if (v.exits.length) {
    parts.push("");
    const exitDescs = v.exits.map((e) =>
      e.known ? e.direction : `${e.direction} (unexplored)`,
    );
    parts.push(`Exits: ${exitDescs.join(", ")}.`);
  }
  return parts.join("\n");
}
