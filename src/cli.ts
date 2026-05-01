/**
 * REPL — DeepSeek-driven roguelike DM.
 *
 * `new` rolls a fresh scenario via worldgen, prints the goal banner, then
 * begins play. Each turn the model queries / mutates the world via tool
 * calls and emits narration. After every turn the harness checks
 * victory/defeat rules; on hit, runs an epilogue and exits.
 *
 * Meta-commands handled locally (no LLM): /save, /slots, /help, /quit,
 * /look, /inv, /where, /debug, /scenario, /stats.
 *
 * Usage:
 *   npm run play                — load slot "default" if present (exploration mode if rules lost), else worldgen
 *   npm run play -- new         — fresh worldgen scenario in slot "default"
 *   npm run play -- <slot>      — load named slot, or worldgen into it
 *   npm run play -- seed        — load the static cottage debug seed (no roguelike rules)
 *
 * Env:
 *   DEEPSEEK_API_KEY    required
 *   ADVENTURE_THEME     override the random worldgen theme
 *   ADVENTURE_DEBUG     dump tool-call counts per turn
 */

import { createInterface } from "node:readline";
import { stdin, stdout, argv, env } from "node:process";
import { resolve } from "node:path";
import { createSession, type PrologSession, unq } from "./prolog.js";
import { runEpilogue, runTurn, runWorldgen } from "./dm.js";
import {
  describeCurrent,
  formatLocation,
  getInventory,
  getPlayerLoc,
} from "./world.js";
import { listSlots, loadGame, newGame, saveGame, slotExists } from "./persist.js";
import { endingBanner, openingBanner, renderMarkdown, style } from "./render.js";

const SEED = resolve("seeds/cottage.pl");
const DEFAULT_SLOT = "default";

interface BootResult {
  slot: string;
  /** When false, the run is read-only (e.g. loaded slot with no victory rules). */
  rulesLive: boolean;
}

async function bootstrap(session: PrologSession): Promise<BootResult> {
  const argSlot = argv[2];

  if (argSlot === "seed") {
    console.log(style.aside(`(loading static cottage seed — no roguelike rules)`));
    await newGame(session, SEED);
    return { slot: DEFAULT_SLOT, rulesLive: false };
  }

  if (argSlot === "new") {
    console.log(style.aside(`(rolling a fresh scenario...)`));
    const wg = await runWorldgenWithRetry(session);
    if (!wg) process.exit(1);
    await printOpening(session, wg.narration, wg.theme);
    return { slot: DEFAULT_SLOT, rulesLive: true };
  }

  const slot = argSlot ?? DEFAULT_SLOT;
  if (slotExists(slot)) {
    console.log(style.aside(`(loaded slot "${slot}")`));
    await loadGame(session, slot);
    const vc = await session.query("clause(victory, _)");
    const live = vc.status === "success" && vc.answers.length > 0;
    if (!live) {
      console.log(
        style.warn(
          "(WARNING: this slot has no victory/0 rules in memory. Save/load does not preserve worldgen rules — exploration only.)",
        ),
      );
    }
    return { slot, rulesLive: live };
  }

  console.log(style.aside(`(no save in slot "${slot}" — rolling a fresh scenario...)`));
  const wg = await runWorldgenWithRetry(session);
  if (!wg) process.exit(1);
  await printOpening(session, wg.narration, wg.theme);
  return { slot, rulesLive: true };
}

async function runWorldgenWithRetry(session: PrologSession) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const wg = await runWorldgen(session);
    if (wg.ok) return wg;
    console.log(
      style.warn(
        `(worldgen attempt ${attempt} failed: ${wg.violations?.length ?? 0} unresolved invariant(s))`,
      ),
    );
    for (const v of wg.violations ?? []) console.log(style.warn(`  - ${v.detail}`));
    if (attempt < 2) console.log(style.aside("(retrying)"));
  }
  console.error(style.error("worldgen failed after 2 attempts. Try again — DeepSeek output is non-deterministic."));
  return null;
}

async function printOpening(
  session: PrologSession,
  openingNarration: string,
  theme: string,
): Promise<void> {
  const sc = await getScenario(session);
  const tl = await getTurnLimit(session);
  console.log("");
  console.log(
    openingBanner({
      theme,
      setting: sc?.setting,
      premise: sc?.premise,
      goal: sc?.goal,
      turnLimit: tl,
    }),
  );
  console.log("");
  if (openingNarration) console.log(renderMarkdown(openingNarration));
}

async function getScenario(session: PrologSession): Promise<{ setting: string; premise: string; goal: string } | null> {
  const r = await session.query("scenario(S, P, G)");
  if (r.status !== "success" || r.answers.length === 0) return null;
  const b = r.answers[0].bindings;
  return { setting: unq(b.S), premise: unq(b.P), goal: unq(b.G) };
}

async function getTurnLimit(session: PrologSession): Promise<number | null> {
  const r = await session.query("turn_limit(N)");
  if (r.status !== "success" || r.answers.length === 0) return null;
  const v = parseInt(r.answers[0].bindings.N, 10);
  return Number.isFinite(v) ? v : null;
}

async function getTurnCount(session: PrologSession): Promise<number> {
  const r = await session.query("turn_count(N)");
  if (r.status !== "success" || r.answers.length === 0) return 0;
  const v = parseInt(r.answers[0].bindings.N, 10);
  return Number.isFinite(v) ? v : 0;
}

async function getStats(session: PrologSession): Promise<{ key: string; value: string }[]> {
  const r = await session.query("player_stat(K, V)");
  if (r.status !== "success") return [];
  return r.answers.map((a) => ({ key: unq(a.bindings.K), value: unq(a.bindings.V) }));
}

async function statusLine(session: PrologSession): Promise<string> {
  const tc = await getTurnCount(session);
  const tl = await getTurnLimit(session);
  const stats = await getStats(session);
  const parts = [`turn ${tc}${tl !== null ? `/${tl}` : ""}`];
  for (const s of stats) parts.push(`${s.key}=${s.value}`);
  return `[${parts.join(" · ")}]`;
}

async function main(): Promise<void> {
  if (!env.DEEPSEEK_API_KEY) {
    console.error("DEEPSEEK_API_KEY is not set. Export it before running.");
    process.exit(1);
  }

  const session = await createSession();
  const boot = await bootstrap(session);
  let { slot } = boot;

  // For seed/loaded paths, dump the canonical view of the starting room.
  if (argv[2] === "seed" || (slotExists(slot) && argv[2] !== "new" && argv[2] !== undefined)) {
    const view = await describeCurrent(session);
    if (view) console.log(formatLocation(view));
  }

  await saveGame(session, slot);
  console.log(`\n${style.status(await statusLine(session))}`);
  stdout.write("\n" + style.prompt("> "));

  const rl = createInterface({ input: stdin, output: stdout, terminal: false });
  let chain: Promise<void> = Promise.resolve();
  let done = false;
  let gameOver = false;

  rl.on("line", (line) => {
    chain = chain.then(async () => {
      if (done) return;
      const raw = line.trim();
      if (!raw) {
        stdout.write("> ");
        return;
      }

      try {
        if (raw.startsWith("/")) {
          await handleMeta(raw, session, () => slot, (s) => { slot = s; }, () => { done = true; rl.close(); });
        } else if (gameOver) {
          console.log("(this run has ended — start a new one with: npm run play -- new)");
        } else {
          const result = await runTurn(session, raw);
          if (result.narration) console.log(result.narration);
          else if (result.llmError) console.log(style.warn(`(dm unavailable: ${result.llmError})`));
          else console.log("(no narration)");
          if (result.llmError) {
            console.log(style.warn(`(world state may be inconsistent — dm error mid-turn)`));
          }
          if (!result.ok) {
            console.log(
              `\n[harness: world state still has ${result.violations?.length ?? 0} unresolved invariant(s) after ${result.retries} retry/retries]`,
            );
          }
          if (env.ADVENTURE_DEBUG) {
            console.log(
              `[debug: ${result.toolCalls} tool calls, ${result.retries} retries, ok=${result.ok}, ended=${JSON.stringify(result.endedWith)}]`,
            );
          }
          await saveGame(session, slot);
          console.log(`\n${await statusLine(session)}`);

          if (result.endedWith !== null) {
            await runEnding(session, result.endedWith);
            gameOver = true;
            done = true;
            rl.close();
            return;
          }
        }
      } catch (e) {
        console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!done) stdout.write("\n> ");
    });
  });

  await new Promise<void>((res) => rl.once("close", () => res()));
  await chain;
  await session.dispose();
}

async function runEnding(session: PrologSession, outcome: "won" | { lost: string }): Promise<void> {
  console.log("");
  console.log("=".repeat(72));
  console.log(outcome === "won" ? "  YOU WIN" : `  YOU LOSE — ${outcome.lost}`);
  console.log("=".repeat(72));
  console.log("");
  const ep = await runEpilogue(session, outcome);
  if (ep.narration) console.log(ep.narration);
  console.log("");
  console.log(`(final turn: ${await getTurnCount(session)})`);
}

async function handleMeta(
  raw: string,
  session: PrologSession,
  getSlot: () => string,
  setSlot: (s: string) => void,
  quit: () => void,
): Promise<void> {
  const [cmd, ...rest] = raw.slice(1).trim().split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd.toLowerCase()) {
    case "quit":
    case "exit":
    case "q": {
      await saveGame(session, getSlot());
      console.log(`(saved slot "${getSlot()}")`);
      quit();
      return;
    }
    case "save": {
      const target = arg || getSlot();
      await saveGame(session, target);
      setSlot(target);
      console.log(`(saved slot "${target}")`);
      return;
    }
    case "slots": {
      const all = await listSlots();
      console.log(all.length ? `slots: ${all.join(", ")}` : "(no saved slots)");
      return;
    }
    case "look":
    case "l": {
      const v = await describeCurrent(session);
      console.log(v ? formatLocation(v) : "(no current location)");
      return;
    }
    case "inv":
    case "inventory":
    case "i": {
      const inv = await getInventory(session);
      console.log(inv.length ? `Carrying: ${inv.map((i) => i.name).join(", ")}` : "Carrying nothing.");
      return;
    }
    case "where": {
      console.log(`player_at: ${(await getPlayerLoc(session)) ?? "(none)"}`);
      return;
    }
    case "scenario": {
      const sc = await getScenario(session);
      if (!sc) { console.log("(no scenario set)"); return; }
      console.log(`setting: ${sc.setting}`);
      console.log(`premise: ${sc.premise}`);
      console.log(`goal:    ${sc.goal}`);
      return;
    }
    case "stats": {
      console.log(await statusLine(session));
      return;
    }
    case "debug": {
      for (const goal of [
        "scenario(S, P, G)", "game_status(X)", "turn_limit(N)", "turn_count(N)",
        "player_at(L)", "player_has(I)", "at(X, L)", "visited(L)",
        "condition(L, C)", "flag(F)", "npc_state(C, S)", "told(C, T)",
        "item_state(I, S)", "holds(C, I)", "player_stat(K, V)",
      ]) {
        const r = await session.query(goal);
        if (r.status !== "success") continue;
        console.log(`${goal}:`);
        for (const a of r.answers) console.log(`  ${a.formatted}`);
        if (!r.answers.length) console.log("  (none)");
      }
      console.log("victory clauses:");
      const v = await session.query("clause(victory, B)");
      for (const a of (v.status === "success" ? v.answers : [])) console.log(`  ${a.formatted}`);
      console.log("defeat clauses:");
      const d = await session.query("clause(defeat(R), B)");
      for (const a of (d.status === "success" ? d.answers : [])) console.log(`  ${a.formatted}`);
      return;
    }
    case "help":
    case "?": {
      console.log(`Meta-commands (prefix with /):
  /scenario           re-print premise + goal
  /stats              show turn/limit + player stats
  /look | /l          raw schema-based view (bypasses DM)
  /inv | /i           raw inventory list
  /where              show player_at
  /save [slot]        save current world to slot
  /slots              list saved slots
  /debug              dump KB state + victory/defeat rules
  /help | /?          this help
  /quit | /q          save and exit

Anything else is sent to the DM as a player command — e.g.:
  look around
  go north
  examine the table
  talk to the keeper
  smash the lantern`);
      return;
    }
    default:
      console.log(`unknown meta-command /${cmd} — try /help`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
