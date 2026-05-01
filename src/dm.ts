/**
 * DM tool loop — used in three modes:
 *
 *   - WORLDGEN  : roll a fresh roguelike scenario at game start. The
 *                 model invents location/3, item_def/4, character_def/4,
 *                 scenario/3, victory/0, defeat/1 rules, and seeds
 *                 game_status, turn_limit, player_at, player_stat.
 *   - PLAY      : per player command — query KB, mutate state, narrate.
 *   - EPILOGUE  : a closing narration after victory or defeat is detected.
 *
 * All three drive the same tool-call REPL against a persistent SWI-Prolog
 * session: query → assert → state_set → narrate → end_turn. They differ
 * only in (a) system prompt, (b) initial user message (context bundle),
 * and (c) the invariant check after end_turn (worldgen wants more).
 *
 * Long-term game memory lives in the Prolog KB (event_log, condition,
 * scenario, npc_state). Conversation history is fresh per turn — the
 * KB is the source of truth.
 */

import { chat, type ChatMessage } from "./llm.js";
import { executeTool, TOOL_SCHEMAS, type ToolContext } from "./tools.js";
import type { PrologSession } from "./prolog.js";
import { unq } from "./prolog.js";

const MAX_TOOL_TURNS_PLAY = 16;
const MAX_TOOL_TURNS_WORLDGEN = 32;
const MAX_TOOL_TURNS_EPILOGUE = 6;
const MAX_RETRIES_ON_CONTRADICTION = 2;

// =====================================================================
// Themes — random scenario seeds picked at worldgen time.
// =====================================================================

export const THEMES = [
  "the last lighthouse keeper before a black storm makes landfall",
  "a thieves'-guild heist on the eve of a royal coronation",
  "a derelict generation ship drifting toward a dying star",
  "a biotech lab in lockdown after a containment breach",
  "a ronin's dawn raid on a yokai-infested temple",
  "a deep-sea station whose lights just went out",
  "a dwarven vault sealed against something inside, not outside",
  "a courier carrying a sealed letter through a city under curfew",
  "a haunted opera house on the night of its first performance in fifty years",
  "a smuggler trapped in a customs bureau as it is mysteriously evacuated",
  "an apprentice cartographer surveying a forest that refuses to map",
  "a clocktower whose hands have stopped, and whose town has stopped with them",
  "an exorcist arriving at a frontier mining town the day after the saints' feast",
  "a deserter fleeing across a battlefield where the bodies are getting up",
  "a tax collector's last visit to a manor whose lord went mad three winters ago",
];

export function pickTheme(): string {
  const override = process.env.ADVENTURE_THEME;
  if (override) return override;
  return THEMES[Math.floor(Math.random() * THEMES.length)];
}

// =====================================================================
// System prompts
// =====================================================================

const SCHEMA_BLOCK = `# World schema

Lore (append-only, never retracted):
  location(Id, ShortName, OriginalDesc).         % Id is snake_case atom
  exit(FromLoc, Direction, ToLoc).               % e.g. exit(yard, north, cottage_door)
  item_def(Id, Name, Desc, Tags).                % Tags is a list: [takeable, container, weapon, lit, hidden, fixed, readable]
  character_def(Id, Name, Desc, Disposition).    % Disposition: friendly | neutral | wary | hostile
  fact(Subject, Predicate, Object).              % free-form lore triples
  scenario(SettingAtom, PremiseString, GoalString).   % set ONCE during worldgen
  victory.                                        % rule(s): true ⇒ player wins
  defeat(Reason).                                 % rule(s): true ⇒ player loses with that reason

Mutable state (mutate ONLY via state_set directives):
  player_at(Loc).
  player_has(ItemId).
  at(EntityId, Loc).
  visited(Loc).
  npc_state(CharId, [k=v, ...]).
  flag(Atom).
  told(CharId, Topic).                              % conversation topics discussed with an NPC; append each time you narrate dialogue
  item_state(ItemId, [k=v, ...]).                   % mutable item properties: lit, open, locked, broken, etc. Retractall + re-assert to update.
  holds(ContainerId, ItemId).                       % items inside containers; assert when placed, retract when removed
  condition(Loc, DescAtomOrString).               % layered changes since first visit; KEY for revisits
  turn_count(N).
  event_log(N, Text).
  player_stat(Key, Value).                        % e.g. player_stat(health, 8)
  game_status(playing | won | lost(Reason)).
  turn_limit(N).                                  % roguelike soft cap

Helpful derived rules (already defined):
  visible_item(I), takeable_item(I), present_npc(C),
  exit_here(D, To), known_destination(D), unknown_destination(D),
  already_visited(L), location_conditions(L, Cs).
  defeat(timeout) :- turn_count(N), turn_limit(L), N >= L.   % built in`;

const PLAY_SYSTEM_PROMPT = `You are the Dungeon Master of a short, roguelike-style text adventure. The world's ground truth lives in a SWI-Prolog knowledge base. Your job: take a player command, decide what happens, mutate the world via tools, and narrate what the player sees — ALWAYS grounded in queryable facts.

${SCHEMA_BLOCK}

# Tools

- world_query(goal): run a Prolog query — read-only. USE THIS FIRST whenever you're unsure (e.g. "do I have an item that could open this?"). Results are capped at 50 answers — if the cap is hit, refine your query to be more specific.
- world_assert(code): append lore. Bare clauses only; only the lore predicates listed above. Use when player enters uncharted territory or you introduce new items / NPCs / lore facts.
- state_set(code): mutate state. Each statement must be a directive whose body is ONLY assertz/retract/retractall calls, joined by commas. No arithmetic, no \`is/2\`, no \`write\`, no other goals. To compute a new value (e.g. turn_count + 1), FIRST world_query the current value, THEN state_set with the literal new value:
    world_query("turn_count(N)")          # returns e.g. N = 3
    state_set(":- retractall(turn_count(_)), assertz(turn_count(4)).")
- narrate(text): emit prose to the player. Terse, second-person, atmospheric.
- end_turn(): finalize. Call EXACTLY ONCE per player command, last.

# Flow per turn

1. Read the context bundle. Notice the scenario premise/goal — every turn should be moving toward (or away from) victory.
2. ALWAYS increment turn_count by exactly 1 every turn (query its current value, then state_set with N+1). The turn_limit will run out — that's the roguelike clock.
3. If the player wants to enter UNCHARTED territory (the destination has no location/3), use world_assert FIRST: location/3 + outgoing exit/3 + any item_def/4 / character_def/4 you place there. Pick stable snake_case ids that fit the scenario's setting.
4. Use state_set to apply consequences: move the player, take/drop items, layer condition/2 changes, update npc_state/2 (including disposition changes), assert told/2 for conversations, update item_state/2 for object changes, manage holds/2 when containers are opened/closed, update player_stat/2 if relevant, append event_log/2 (turn_count, brief sentence).
5. narrate(text) — describe what the player sees / what happened. Don't recite the location's canonical description verbatim; weave it together with active conditions and the present items / NPCs.
6. end_turn().

# Narration-KB consistency (critical — read before every narrate)

Every concrete, interactable object you mention in narration MUST already have item_def/4 + at/2 (or player_has/1) in the KB. If you describe a lantern, a key, a book — it must be a real item in the database. Otherwise the world "forgets" it and the next turn will contradict you.

BEFORE you call narrate(), verify the KB:
  world_query("at(I, <loc>), item_def(I, N, _, _)")  → does every item you plan to describe actually exist?

If an item you want to describe is NOT in the KB:
  1. world_assert("item_def(id, 'name', 'desc', [takeable]).")  FIRST
  2. state_set(":- assertz(at(id, <loc>)).")                     SECOND
  3. narrate(...)                                                 THIRD — only after asserting

Example of the bug this prevents:
  // DM narrates a lantern that was never asserted:
  narrate("A lantern sits on the altar.") → end_turn()
  // Next turn: "There's no lantern here." ← contradiction

  // Correct: assert first
  world_assert("item_def(lantern, 'miner lantern', 'Dented brass, unlit.', [takeable, lit]).")
  state_set(":- assertz(at(lantern, church)).")
  narrate("A miner's lantern sits on the altar step — dented brass, sooty glass. It's unlit.")
  end_turn()

Rule of thumb: if the player could pick it up, examine it, or interact with it, it needs item_def/4. Scenery (pews, dust motes, splintered wood) does not.

# Action tracking via event_log (critical)

The KB must remember what the player has ALREADY DONE so the DM never suggests or re-does completed actions. Use event_log/2 for every significant player action — searching, examining, opening, solving, finding clues. The context bundle shows the last 5 events to the DM every turn.

After EVERY significant action, log it:
  state_set(":- assertz(event_log(<turn>, '<concise description>')).")

Examples:
  - Player searches a body → event_log(N, 'searched father murphys body — found mine dust on palm, no keys')
  - Player examines a locked door → event_log(N, 'examined sacristy door — heavy oak, iron lock, no keyhole visible')
  - Player solves a puzzle → event_log(N, 'placed both crucifixes in the altar niche — heard a grinding sound from below')

BEFORE suggesting actions or describing what remains to be done:
  world_query("event_log(_, T)")  → review what the player has already accomplished

If the player already did something (per event_log), DON'T suggest they do it again. Instead, build on it or acknowledge it was already done.

Example of the bug this prevents:
  Turn 4: player searches body → DM narrates findings but does NOT log event_log
  Turn 5: DM suggests "Would you like to search the body?" ← player already did this!

# Revisit rule (very important)

When the player re-enters a location they've been before:
  - The original location/3 description is IMMUTABLE. Treat it as the canonical baseline.
  - Any changes since first visit are encoded as condition/2 facts attached to that location.
  - Your narration MUST be consistent with: original description + accumulated conditions.
  - To represent change, ADD a new condition/2 (e.g. condition(cottage, 'burned to a charred shell')) — never rewrite the original description.

# NPC conversation memory (very important)

NPCs must remember prior conversations. The KB tracks what's been discussed with each NPC via told(CharId, Topic). Follow these rules EVERY time the player interacts with an NPC:

1. BEFORE narrating NPC dialogue, ALWAYS world_query(\"told('<char_id>', T)\") to see what topics have already been discussed.
2. If NO told/2 facts exist for this NPC → it's a FIRST meeting. The NPC introduces themselves naturally (but briefly — no repeating full backstory). After narrating, state_set this:
     :- assertz(told('<char_id>', greeted)).
3. If told/2 facts DO exist → the NPC REMEMBERS previous conversations. Greet the player as someone they've spoken to before. Reference prior topics by name. Do NOT re-introduce themselves or repeat the same information they already shared.
4. After EVERY significant piece of dialogue (giving directions, revealing lore, answering a question, reacting to player actions), APPEND a told/2 fact summarizing the topic discussed:
     :- assertz(told('<char_id>', <topic_atom>)).
   Use snake_case topic atoms: manor_entrance, lord_blackwood, treasury_location, etc.
5. NEVER retract told/2 facts — they are append-only, building the conversation history over time.

Example flow:
  Player: "ask the reeve about the manor"
  DM queries: told(reeve, T) → no answers (first meeting)
  DM narrates intro dialogue, then state_set:
    :- assertz(told(reeve, greeted)).
    :- assertz(told(reeve, manor_entrance)).

  Later, player: "ask the reeve about the lord"
  DM queries: told(reeve, T) → [greeted, manor_entrance]
  DM narrates: "The reeve looks up, recognizing you. 'You again. About the lord, then...'"
  After narrating: :- assertz(told(reeve, lord_blackwood)).

# Item & object state (very important)

Objects in the world change. Track every meaningful mutation so the world stays consistent:

- item_state(ItemId, [k=v, ...]) — mutable key-value list. Use it for states like: [lit=true], [open=true], [locked=false], [broken=true], [wet=true]. When the player interacts with an object and changes its state, retractall + re-assert the whole list:
    state_set(":- retractall(item_state(lamp, _)), assertz(item_state(lamp, [lit=false])).")

- holds(ContainerId, ItemId) — items inside containers (chests, barrels, drawers). ALWAYS check holds/2 before narrating container contents:
    world_query("holds(chest, I), item_def(I, N, _, _)")
  When the player opens a container, narrate what's inside based on holds/2. When they take an item from a container, retract the holds fact AND assert player_has:
    state_set(":- retract(holds(chest, coin)), assertz(player_has(coin)).")
  NEVER place a container's contents in the room via at/2 — always use holds/2.

- When an item is DESTROYED or BROKEN, retract player_has/at AND assert item_state(id, [broken=true]). Don't silently remove it — the player should still notice the remains in the room description.

- When an NPC's DISPOSITION changes (friendly → hostile after a betrayal, etc.), update npc_state with the new disposition:
    state_set(":- retractall(npc_state(guard, _)), assertz(npc_state(guard, [disposition=hostile, reason=player_stole_key])).")
  The DM should check npc_state for disposition before deciding how an NPC reacts to the player.

# flag/1 vs condition/2: when to use each

- flag(Atom): boolean world-level toggles. Use for global events that affect many things: flag(ship_is_sinking), flag(alarm_sounded), flag(reactor_meltdown). Flags are perfect for defeat/1 rule bodies.
- condition(Loc, Desc): location-level changes. Use for room-specific mutations: condition(kitchen, 'bloody handprints smear the wall').
  Rule of thumb: if the change is tied to ONE location, use condition/2. If it affects the whole world or multiple locations, use flag/1.

- The scenario's victory/defeat conditions are already in the KB. After your end_turn the harness queries them automatically — DO NOT call state_set on game_status yourself; the harness owns that.
- You MAY adjust player_stat/2 (e.g. take damage in combat, gain stamina from rest). Be consistent with prior turns.
- You MAY make the player's situation harder over time — that's the genre. But every loss should feel earned, traceable to a player choice.

# Consistency invariants

After end_turn the harness checks: player_at must reference a defined location; every player_has/at must reference a defined item_def/character_def; every exit/3 must point to a defined location. On failure you'll get a retry message — fix it via additional tool calls, then end_turn again.

# Style

- Terse, second-person, atmospheric. No purple prose, no meta-commentary.
- Don't reveal mechanics ("you assert the fact...") — narration is in-fiction only.
- Stay inside the scenario's setting and tone. The premise tells you the genre.`;

const WORLDGEN_SYSTEM_PROMPT = `You are the DESIGNER for a short, roguelike-style text adventure: a 5-10 minute single-session run with a clear goal, a turn budget, and at least one way to fail. You build the entire scenario at game start by populating a SWI-Prolog knowledge base. After your end_turn the play loop begins.

${SCHEMA_BLOCK}

# Tools (same as during play, used here for setup)

- world_query, world_assert, state_set, narrate, end_turn.

# Your task

Given a THEME (in the user message below), create a complete, playable scenario. By the time you call end_turn the KB MUST satisfy ALL of the following — the harness checks them and will retry you if anything is missing:

1. **scenario/3**:
     world_assert("scenario(<setting_atom>, '<2-3 sentence premise>', '<one-sentence player goal>').")
2. **victory rule**: at least one
     world_assert("victory :- player_has(crown), player_at(throne_room).")
   You may have multiple. Each is a Prolog rule whose head is \`victory\` and whose body lists the conditions. The body should be REACHABLE — derivable from facts the player can plausibly establish in 15-25 turns.
3. **defeat rule**: at least one in-fiction one (besides the built-in timeout)
     world_assert("defeat(starved) :- player_stat(hunger, H), H >= 100.")
     world_assert("defeat(burned) :- flag(reactor_meltdown).")
4. **3-6 starting locations** (location/3 + exits) with at least one path the player can extend (an exit pointing to a location_id you DON'T define yet — the play DM will generate it on traversal). Pick stable snake_case ids that fit the theme.
5. **2-5 items** (item_def/4) placed via at/2 or carried via player_has/1. Use Tags meaningfully.
6. **0-3 NPCs** (character_def/4) placed via at/2.
7. **Initial mutable state via state_set**:
     :- assertz(player_at(<starting_loc>)), assertz(visited(<starting_loc>)), assertz(turn_count(0)), assertz(turn_limit(25)), assertz(game_status(playing)).
   Plus any \`assertz(player_stat(...))\` and \`assertz(at(...))\` for items/NPCs.
   - turn_limit should be 18-30. Tighter = more tense.
   - player_stat(health, ...) is recommended; add others if your defeat rules need them.
8. **Opening narration via narrate(text)**: 2-4 short paragraphs setting the scene, naming the goal in fiction (without reciting it as game text). End with a hook — what's the first decision the player faces?
9. **end_turn()**.

# Design principles

- **Tight scope.** 4-5 locations is plenty. Two of them should already be reachable; the rest are hooks.
- **Clear win condition.** The player should be able to read the goal once and know what to do. The body of victory/0 should match.
- **Fair death.** Defeat conditions should be foreshadowed in the opening narration (mention the rising tide, the drained battery, the wound that won't stop bleeding).
- **Items matter.** Don't decorate. Each item_def should plausibly be in the body of a victory/0 or defeat/1 rule, OR in the world_query the DM will run during play.
- **The theme is non-negotiable.** Stay inside it. Tone, names, ids, item flavor — all consistent with the theme atom.
- **No state_set on game_status.** That's harness-owned.
- **No directives mixing assertz with arithmetic.** state_set bodies are pure assertz/retract/retractall calls.

# Tone

The opening narration should hit hard and fast — second-person, present tense, specific concrete detail. No throat-clearing. No "Welcome, adventurer." Drop the player into the moment.`;

const EPILOGUE_SYSTEM_PROMPT = `You are the DM writing the closing narration for a roguelike text-adventure run that just ended. The harness will tell you the outcome (victory or defeat with a reason) and give you the final state of the KB. Your job: write a single short, atmospheric closing scene — 2-4 paragraphs — that resolves the story consistent with that final state.

${SCHEMA_BLOCK}

# Constraints

- Use ONLY narrate(text) and end_turn(). Do NOT world_assert / state_set — the run is over.
- You MAY world_query to ground the closing details in the KB.
- Stay inside the scenario's tone and setting.
- For victory: payoff. The goal achieved, what the player sees / hears / does in that moment.
- For defeat: the cause matters. If reason=timeout, the budget ran out and the world resolved without the player. If reason=<custom>, narrate that specific failure.
- Keep it tight. No epilogue-of-the-epilogue. End on a clean image.`;

// =====================================================================
// Helpers
// =====================================================================

interface CtxBundle {
  text: string;
  currentLoc: string | null;
  visited: boolean;
}

async function findOne(session: PrologSession, goal: string) {
  const r = await session.query(goal);
  if (r.status !== "success" || r.answers.length === 0) return null;
  return r.answers[0].bindings;
}

async function findAll(session: PrologSession, goal: string) {
  const r = await session.query(goal);
  if (r.status !== "success") return [];
  return r.answers.map((a) => a.bindings);
}

async function buildScenarioBlock(session: PrologSession): Promise<string[]> {
  const lines: string[] = [];
  const sc = await findOne(session, "scenario(S, P, G)");
  if (sc) {
    lines.push(`# Scenario`);
    lines.push("");
    lines.push(`setting: ${unq(sc.S)}`);
    lines.push(`premise: ${unq(sc.P)}`);
    lines.push(`goal:    ${unq(sc.G)}`);
    const turn = await findOne(session, "turn_count(N)");
    const limit = await findOne(session, "turn_limit(L)");
    if (turn || limit) {
      lines.push(
        `turn:    ${turn ? unq(turn.N) : "?"} / ${limit ? unq(limit.L) : "?"}`,
      );
    }
    const stats = await findAll(session, "player_stat(K, V)");
    if (stats.length) {
      lines.push(
        `stats:   ${stats.map((s) => `${unq(s.K)}=${unq(s.V)}`).join(", ")}`,
      );
    }
    lines.push("");
  }
  return lines;
}

async function buildPlayContext(
  session: PrologSession,
  playerCommand: string,
): Promise<CtxBundle> {
  const lines: string[] = [];
  lines.push(...(await buildScenarioBlock(session)));

  const locRow = await findOne(session, "player_at(L)");
  const locId = locRow ? unq(locRow.L) : null;

  lines.push(`# Current ground truth`);
  lines.push("");

  if (!locId) {
    lines.push("player_at/1: NONE — the player has no current location. You must establish one.");
  } else {
    lines.push(`player_at: ${locId}`);
    const locDef = await findOne(session, `location('${locId}', N, D)`);
    if (locDef) {
      lines.push(`location/3 (immutable): ${locId} :: "${unq(locDef.N)}"`);
      lines.push(`  original_desc: ${unq(locDef.D)}`);
    } else {
      lines.push(
        `location/3: NOT DEFINED for "${locId}" — you must world_assert(location('${locId}', '<short>', '<long>')) before narrating.`,
      );
    }
    const visited = (await findAll(session, `visited('${locId}')`)).length > 0;
    lines.push(`visited(${locId}): ${visited ? "true" : "false"}`);

    const conds = await findAll(session, `condition('${locId}', C)`);
    if (conds.length) {
      lines.push(`active conditions:`);
      for (const c of conds) lines.push(`  - ${unq(c.C)}`);
    }

    const exits = await findAll(session, `exit('${locId}', Dir, To)`);
    if (exits.length) {
      lines.push(`exits from here:`);
      for (const e of exits) {
        const to = unq(e.To);
        const known = (await findAll(session, `location('${to}', _, _)`)).length > 0;
        lines.push(`  - ${unq(e.Dir)} -> ${to}${known ? "" : "  [UNDEFINED — generate location/3 if player goes here]"}`);
      }
    } else {
      lines.push("exits from here: (none defined yet)");
    }

    const items = await findAll(
      session,
      `at(I, '${locId}'), item_def(I, N, D, T)`,
    );
    if (items.length) {
      lines.push(`items here:`);
      for (const it of items) {
        const iid = unq(it.I);
        lines.push(`  - ${iid} ("${unq(it.N)}") tags=${unq(it.T)}`);
        const isRow = await findOne(session, `item_state('${iid}', S)`);
        if (isRow) lines.push(`    item_state: ${unq(isRow.S)}`);
        const holdsRows = await findAll(session, `holds('${iid}', HI), item_def(HI, HN, _, _)`);
        if (holdsRows.length) {
          const contents = holdsRows.map((h) => unq(h.HN)).join(", ");
          lines.push(`    contains: [${contents}]`);
        }
      }
    }

    const npcs = await findAll(
      session,
      `at(C, '${locId}'), character_def(C, N, D, Disp)`,
    );
    if (npcs.length) {
      lines.push(`NPCs here:`);
      // Batch NPC state + told queries in parallel
      const npcDetails = await Promise.all(
        npcs.map(async (n) => {
          const id = unq(n.C);
          const [stateRow, toldRows] = await Promise.all([
            findOne(session, `npc_state('${id}', S)`),
            findAll(session, `told('${id}', T)`),
          ]);
          return { id, name: unq(n.N), disp: unq(n.Disp), stateRow, toldRows };
        }),
      );
      for (const d of npcDetails) {
        const st = d.stateRow ? unq(d.stateRow.S) : "[]";
        lines.push(`  - ${d.id} ("${d.name}") disposition=${d.disp} state=${st}`);
        if (d.toldRows.length) {
          const topics = d.toldRows.map((t) => unq(t.T)).join(", ");
          lines.push(`    conversation so far: [${topics}]`);
        } else {
          lines.push(`    conversation so far: (never spoken to)`);
        }
      }
    }
  }

  const inv = await findAll(session, `player_has(I), item_def(I, N, _, _)`);
  if (inv.length) {
    lines.push(`inventory: ${inv.map((i) => `${unq(i.I)} ("${unq(i.N)}")`).join(", ")}`);
    for (const it of inv) {
      const iid = unq(it.I);
      const isRow = await findOne(session, `item_state('${iid}', S)`);
      if (isRow) lines.push(`  item_state(${iid}): ${unq(isRow.S)}`);
    }
  } else {
    lines.push("inventory: (empty)");
  }

  const recent = await findAll(session, `event_log(N, T)`);
  if (recent.length) {
    const tail = recent.slice(-5);
    lines.push(`recent events (last ${tail.length}):`);
    for (const ev of tail) lines.push(`  - turn ${unq(ev.N)}: ${unq(ev.T)}`);
  }

  lines.push("");
  lines.push(`# Player command`);
  lines.push("");
  lines.push(playerCommand);

  return {
    text: lines.join("\n"),
    currentLoc: locId,
    visited: locId
      ? (await findAll(session, `visited('${locId}')`)).length > 0
      : false,
  };
}

// =====================================================================
// Invariants
// =====================================================================

interface InvariantViolation {
  kind: string;
  detail: string;
}

async function checkPlayInvariants(session: PrologSession): Promise<InvariantViolation[]> {
  const violations: InvariantViolation[] = [];

  const player = await findOne(session, "player_at(L)");
  if (!player) {
    violations.push({ kind: "no_player_at", detail: "player_at/1 has no clause." });
  } else {
    const loc = unq(player.L);
    const def = await findOne(session, `location('${loc}', _, _)`);
    if (!def) {
      violations.push({
        kind: "player_at_undefined",
        detail: `player_at(${loc}) but no location/3 defined for "${loc}". world_assert it.`,
      });
    }
  }

  const carried = await findAll(session, "player_has(I)");
  for (const c of carried) {
    const id = unq(c.I);
    const def = await findOne(session, `item_def('${id}', _, _, _)`);
    if (!def) {
      violations.push({
        kind: "carried_undefined",
        detail: `player_has(${id}) but no item_def/4 for "${id}".`,
      });
    }
  }

  const here = await findAll(session, "at(X, _)");
  for (const e of here) {
    const id = unq(e.X);
    const itm = await findOne(session, `item_def('${id}', _, _, _)`);
    const chr = await findOne(session, `character_def('${id}', _, _, _)`);
    if (!itm && !chr) {
      violations.push({
        kind: "at_undefined_entity",
        detail: `at(${id}, ...) but no item_def/4 or character_def/4 for "${id}".`,
      });
    }
  }

  const exits = await findAll(session, "exit(_, _, To)");
  const seen = new Set<string>();
  for (const ex of exits) {
    const to = unq(ex.To);
    if (seen.has(to)) continue;
    seen.add(to);
    const def = await findOne(session, `location('${to}', _, _)`);
    if (!def) {
      violations.push({
        kind: "dangling_exit",
        detail: `exit/3 points to "${to}" but no location/3 defined.`,
      });
    }
  }

  return violations;
}

async function checkWorldgenInvariants(session: PrologSession): Promise<InvariantViolation[]> {
  // First: everything play requires.
  const violations = await checkPlayInvariants(session);

  // scenario/3 must exist.
  const sc = await findOne(session, "scenario(_, _, _)");
  if (!sc) {
    violations.push({
      kind: "no_scenario",
      detail: "scenario/3 not asserted. world_assert(\"scenario(<setting_atom>, '<premise>', '<goal>').\")",
    });
  }

  // At least one victory rule beyond the built-in baseline.
  const vc = await session.query("clause(victory, _)");
  if (vc.status !== "success" || vc.answers.length === 0) {
    violations.push({
      kind: "no_victory_rule",
      detail: "no victory/0 clause. world_assert at least one rule, e.g. \"victory :- player_has(thing), player_at(place).\"",
    });
  }

  // At least one defeat rule besides the built-in timeout. (We can't easily
  // distinguish "the timeout one" from custom in WASM SWI without extra
  // bookkeeping, so we just require >= 2 defeat clauses total.)
  const df = await session.query("clause(defeat(_), _)");
  const defeatCount = df.status === "success" ? df.answers.length : 0;
  if (defeatCount < 2) {
    violations.push({
      kind: "needs_in_fiction_defeat",
      detail: "only the built-in defeat(timeout) rule exists. Add at least one in-fiction defeat/1 rule via world_assert (e.g. \"defeat(drowned) :- player_stat(air, A), A =< 0.\").",
    });
  }

  // game_status(playing) must be set.
  const gs = await findOne(session, "game_status(playing)");
  if (!gs) {
    violations.push({
      kind: "no_game_status",
      detail: "game_status(playing) not set. state_set(\":- assertz(game_status(playing)).\")",
    });
  }

  // turn_limit must be set and reasonable.
  const tl = await findOne(session, "turn_limit(N)");
  if (!tl) {
    violations.push({
      kind: "no_turn_limit",
      detail: "turn_limit/1 not set. state_set(\":- assertz(turn_limit(25)).\") — pick something in 18-30.",
    });
  } else {
    const n = parseInt(unq(tl.N), 10);
    if (!Number.isFinite(n) || n < 5 || n > 200) {
      violations.push({
        kind: "bad_turn_limit",
        detail: `turn_limit(${unq(tl.N)}) is out of range; pick 18-30.`,
      });
    }
  }

  // turn_count must exist (the play DM will increment it).
  const tc = await findOne(session, "turn_count(N)");
  if (!tc) {
    violations.push({
      kind: "no_turn_count",
      detail: "turn_count/1 not set. state_set(\":- assertz(turn_count(0)).\")",
    });
  }

  // Puzzle solvability — only check if basics are solid (scenario exists).
  if (violations.filter((v) => v.kind.startsWith("no_") || v.kind === "needs_in_fiction_defeat").length === 0) {
    const puzzleViolations = await checkPuzzleSolvability(session);
    violations.push(...puzzleViolations);
  }

  return violations;
}

// =====================================================================
// Puzzle solvability — structural checks that the generated scenario is
// actually playable. Runs after worldgen invariants.
// =====================================================================

async function checkPuzzleSolvability(session: PrologSession): Promise<InvariantViolation[]> {
  const violations: InvariantViolation[] = [];

  // --- Map connectivity: all defined locations reachable from start? ---
  const startRow = await findOne(session, "player_at(L)");
  if (!startRow) return violations; // handled by other invariants
  const start = unq(startRow.L);

  const locRows = await findAll(session, "location(L, _, _)");
  const allLocs = new Set(locRows.map((r) => unq(r.L)));

  // Build adjacency: only include edges where destination is defined
  const exitRows = await findAll(session, "exit(From, _, To)");
  const adj = new Map<string, string[]>();
  for (const ex of exitRows) {
    const from = unq(ex.From);
    const to = unq(ex.To);
    if (!allLocs.has(to)) continue; // frontier exit — play DM fills this in
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from)!.push(to);
  }

  // BFS from start
  const visited = new Set<string>();
  const queue = [start];
  visited.add(start);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of adj.get(current) ?? []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  for (const loc of allLocs) {
    if (!visited.has(loc)) {
      violations.push({
        kind: "unreachable_location",
        detail: `location "${loc}" has no path from start "${start}" via defined exits. Add exits to connect it to the map.`,
      });
    }
  }

  // --- Item placement: every item_def is placed somewhere ---
  const itemRows = await findAll(session, "item_def(I, N, _, _)");
  const atItems = new Set(
    (await findAll(session, "at(I, _)")).map((r) => unq(r.I)),
  );
  const carriedItems = new Set(
    (await findAll(session, "player_has(I)")).map((r) => unq(r.I)),
  );
  const heldItems = new Set(
    (await findAll(session, "holds(_, I)")).map((r) => unq(r.I)),
  );

  for (const it of itemRows) {
    const id = unq(it.I);
    if (!atItems.has(id) && !carriedItems.has(id) && !heldItems.has(id)) {
      violations.push({
        kind: "unplaced_item",
        detail: `item "${id}" (${unq(it.N)}) has item_def/4 but is not placed anywhere via at/2, player_has/1, or holds/2. Place it in the world.`,
      });
    }
  }

  // --- Victory rule references: items/locations in body must exist ---
  const vc = await session.query("clause(victory, Body)");
  if (vc.status === "success") {
    for (const ans of vc.answers) {
      const bodyText = ans.formatted;
      for (const m of bodyText.matchAll(/player_has\((\w+)\)/g)) {
        const itemId = m[1];
        const exists =
          (await findAll(session, `item_def('${itemId}', _, _, _)`)).length > 0;
        if (!exists) {
          violations.push({
            kind: "victory_refs_missing_item",
            detail: `victory rule references player_has(${itemId}) but item_def/4 does not exist for "${itemId}". Add the item or fix the rule.`,
          });
        }
      }
      for (const m of bodyText.matchAll(/player_at\((\w+)\)/g)) {
        const locId = m[1];
        const exists =
          (await findAll(session, `location('${locId}', _, _)`)).length > 0;
        if (!exists) {
          violations.push({
            kind: "victory_refs_missing_location",
            detail: `victory rule references player_at(${locId}) but location/3 does not exist for "${locId}". Add the location or fix the rule.`,
          });
        }
      }
    }
  }

  // --- Turn budget sanity ---
  const tlRow = await findOne(session, "turn_limit(N)");
  const turnLimit = tlRow ? parseInt(unq(tlRow.N), 10) : 0;
  const locCount = allLocs.size;
  if (turnLimit > 0 && turnLimit < locCount) {
    violations.push({
      kind: "turn_budget_tight",
      detail: `turn_limit(${turnLimit}) is less than the number of defined locations (${locCount}). The player needs at least one turn per room. Increase turn_limit to at least ${locCount * 2}.`,
    });
  }

  return violations;
}

// =====================================================================
// Shared tool-call REPL
// =====================================================================

interface DriveOptions {
  systemPrompt: string;
  userMessage: string;
  session: PrologSession;
  validate?: () => Promise<InvariantViolation[]>;
  maxRetries: number;
  maxToolTurns: number;
  /** When false (epilogue), tool budget exhausted ⇒ stop without forcing a wrap message. */
  forceWrap?: boolean;
  /** Treat a missing narrate() call as a soft violation that earns one retry. */
  requireNarration?: boolean;
}

interface DriveResult {
  narration: string;
  toolCalls: number;
  retries: number;
  violations: InvariantViolation[];
  /** When true, the LLM threw mid-turn — KB may be partially mutated. */
  llmError?: string;
}

async function driveToolLoop(opts: DriveOptions): Promise<DriveResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.userMessage },
  ];
  const toolCtx: ToolContext = { session: opts.session, narrations: [], endRequested: false };
  let toolCallCount = 0;
  let retries = 0;
  let violations: InvariantViolation[] = [];

  while (true) {
    try {
    if (toolCallCount >= opts.maxToolTurns) {
      if (opts.forceWrap !== false) {
        messages.push({
          role: "user",
          content: `Tool-call budget reached (${opts.maxToolTurns}). Wrap up: emit one final narrate (if you haven't), then end_turn.`,
        });
      } else {
        break;
      }
    }

    const resp = await chat({ messages, tools: TOOL_SCHEMAS, toolChoice: "auto" });
    const calls = resp.message.tool_calls ?? [];
    messages.push({
      role: "assistant",
      content: resp.message.content ?? null,
      tool_calls: calls.length ? calls : undefined,
    });

    if (calls.length === 0) {
      const text = (resp.message.content ?? "").trim();
      if (text) toolCtx.narrations.push(text);
      break;
    }

    for (const tc of calls) {
      toolCallCount++;
      const result = await executeTool(tc.function.name, tc.function.arguments, toolCtx);
      messages.push({ role: "tool", tool_call_id: tc.id, content: result.content });
    }

    if (toolCtx.endRequested) {
      const localViolations: InvariantViolation[] = opts.validate ? await opts.validate() : [];
      if (
        opts.requireNarration &&
        toolCtx.narrations.length === 0 &&
        localViolations.length === 0
      ) {
        localViolations.push({
          kind: "no_narration",
          detail:
            "you ended the turn without calling narrate(). The player needs at least one short paragraph of in-fiction response. Call narrate(text), then end_turn.",
        });
      }
      violations = localViolations;
      if (violations.length === 0) break;
      if (retries >= opts.maxRetries) break;
      retries++;
      toolCtx.endRequested = false;
      const lines = [
        `# Invariants failed (retry ${retries}/${opts.maxRetries})`,
        "",
        "The turn does not satisfy all required invariants. Fix each item below, then end_turn again.",
        "",
        ...violations.map((v) => `- [${v.kind}] ${v.detail}`),
      ];
      messages.push({ role: "user", content: lines.join("\n") });
    }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        narration: toolCtx.narrations.join("\n\n").trim(),
        toolCalls: toolCallCount,
        retries,
        violations,
        llmError: msg,
      };
    }
  }

  return {
    narration: toolCtx.narrations.join("\n\n").trim(),
    toolCalls: toolCallCount,
    retries,
    violations,
  };
}

// =====================================================================
// Public API
// =====================================================================

export interface WorldgenResult {
  narration: string;
  theme: string;
  toolCalls: number;
  retries: number;
  ok: boolean;
  violations?: InvariantViolation[];
  llmError?: string;
}

export async function runWorldgen(
  session: PrologSession,
  theme?: string,
): Promise<WorldgenResult> {
  const chosen = theme ?? pickTheme();
  const userMessage = [
    `# THEME`,
    "",
    chosen,
    "",
    `# Your task`,
    "",
    "Build the entire scenario from scratch using the tools. By end_turn the KB must satisfy every invariant listed in the system prompt. Be punchy in the opening narration. The player will read it and then have to act.",
  ].join("\n");

  const r = await driveToolLoop({
    systemPrompt: WORLDGEN_SYSTEM_PROMPT,
    userMessage,
    session,
    validate: () => checkWorldgenInvariants(session),
    maxRetries: 3,
    maxToolTurns: MAX_TOOL_TURNS_WORLDGEN,
  });

  return {
    narration: r.narration,
    theme: chosen,
    toolCalls: r.toolCalls,
    retries: r.retries,
    ok: r.violations.length === 0,
    violations: r.violations.length ? r.violations : undefined,
    llmError: r.llmError,
  };
}

export interface DMTurnResult {
  narration: string;
  toolCalls: number;
  retries: number;
  ok: boolean;
  violations?: InvariantViolation[];
  /** After end_turn, did victory/defeat fire? */
  endedWith: "won" | { lost: string } | null;
  /** When set, the LLM threw mid-turn — KB may be partially mutated. */
  llmError?: string;
}

/**
 * After-turn evaluation: does the KB now satisfy victory or any defeat?
 * Returns the outcome and updates game_status to match.
 */
async function evaluateGameEnd(session: PrologSession): Promise<DMTurnResult["endedWith"]> {
  const win = await session.query("victory");
  if (win.status === "success" && win.answers.length > 0) {
    await session.assert(":- retractall(game_status(_)), assertz(game_status(won)).");
    return "won";
  }
  const loss = await session.query("defeat(R)");
  if (loss.status === "success" && loss.answers.length > 0) {
    const reason = unq(loss.answers[0].bindings.R) || "unknown";
    await session.assert(
      `:- retractall(game_status(_)), assertz(game_status(lost(${escapeAtom(reason)}))).`,
    );
    return { lost: reason };
  }
  return null;
}

function escapeAtom(s: string): string {
  if (/^[a-z][a-zA-Z0-9_]*$/.test(s)) return s;
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export async function runTurn(
  session: PrologSession,
  playerCommand: string,
): Promise<DMTurnResult> {
  const ctx = await buildPlayContext(session, playerCommand);
  const r = await driveToolLoop({
    systemPrompt: PLAY_SYSTEM_PROMPT,
    userMessage: ctx.text,
    session,
    validate: () => checkPlayInvariants(session),
    maxRetries: MAX_RETRIES_ON_CONTRADICTION,
    maxToolTurns: MAX_TOOL_TURNS_PLAY,
    requireNarration: true,
  });

  const endedWith = (r.violations.length === 0 && !r.llmError) ? await evaluateGameEnd(session) : null;

  return {
    narration: r.narration,
    toolCalls: r.toolCalls,
    retries: r.retries,
    ok: r.violations.length === 0 && !r.llmError,
    violations: r.violations.length ? r.violations : undefined,
    endedWith,
    llmError: r.llmError,
  };
}

export interface EpilogueResult {
  narration: string;
  toolCalls: number;
}

export async function runEpilogue(
  session: PrologSession,
  outcome: "won" | { lost: string },
): Promise<EpilogueResult> {
  const sc = await findOne(session, "scenario(S, P, G)");
  const turn = await findOne(session, "turn_count(N)");
  const limit = await findOne(session, "turn_limit(L)");
  const stats = await findAll(session, "player_stat(K, V)");
  const inv = await findAll(session, `player_has(I), item_def(I, N, _, _)`);
  const locRow = await findOne(session, "player_at(L)");

  const outcomeText = outcome === "won" ? "VICTORY" : `DEFEAT (reason: ${outcome.lost})`;

  const userMessage = [
    `# Outcome`,
    "",
    outcomeText,
    "",
    `# Final state`,
    "",
    sc ? `setting: ${unq(sc.S)}` : "",
    sc ? `premise: ${unq(sc.P)}` : "",
    sc ? `goal:    ${unq(sc.G)}` : "",
    `final turn: ${turn ? unq(turn.N) : "?"} / ${limit ? unq(limit.L) : "?"}`,
    `final location: ${locRow ? unq(locRow.L) : "(none)"}`,
    stats.length ? `final stats: ${stats.map((s) => `${unq(s.K)}=${unq(s.V)}`).join(", ")}` : "",
    inv.length ? `inventory: ${inv.map((i) => unq(i.N)).join(", ")}` : "inventory: (empty)",
    "",
    `Write the closing scene now. narrate(text), then end_turn().`,
  ]
    .filter(Boolean)
    .join("\n");

  const r = await driveToolLoop({
    systemPrompt: EPILOGUE_SYSTEM_PROMPT,
    userMessage,
    session,
    maxRetries: 0,
    maxToolTurns: MAX_TOOL_TURNS_EPILOGUE,
    forceWrap: false,
  });

  return { narration: r.narration, toolCalls: r.toolCalls };
}
