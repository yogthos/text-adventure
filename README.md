# text-adventure

A Zork-style roguelike where an LLM plays the role of dungeon master,
**grounded in a SWI-Prolog knowledge base**. The world's ground truth
lives in Prolog. The model can only see facts by querying it, can only
extend lore via append-only assertions, and can only mutate state via
constrained `assertz`/`retract` directives. The harness audits every
turn against schema invariants and forces the model to retry on
contradictions, so the world stays consistent across the run.

Each new game rolls a fresh scenario: the model is asked, in a separate
"designer" pass, to invent a setting, lay down 3-6 starting locations,
write Prolog rules for the win condition and at least one in-fiction
loss condition, set a turn limit (18-30), place items and NPCs, and
narrate an opening scene. Then play begins. The harness evaluates
`victory.` and `defeat(R).` after every turn; on success the run ends
with a closing scene. Designed to fit in a 5-10 minute session.

The DM uses [DeepSeek](https://api-docs.deepseek.com/) by default
(OpenAI-compatible Chat Completions). The Prolog wrapper is lifted from
[`reasoning-harness`](https://github.com/yogthos/reasoning-harness).

## Setup

```bash
npm install
export DEEPSEEK_API_KEY=sk-...
```

## Run

```bash
npm run play -- new          # roll a fresh scenario, save to slot "default"
npm run play                 # resume default slot if it exists, else worldgen
npm run play -- mySlot       # named slot
npm run play -- seed         # load the static cottage debug seed (no roguelike rules)
```

Anything not prefixed with `/` is sent to the DM as a player command:

```
> head east toward the sewer grate
> try the brass key on the padlock
> talk to the operator about the letter
```

`/`-prefixed lines are local meta-commands:

```
/scenario       re-print premise + goal
/stats          show turn/limit + player stats
/look | /l      raw schema-based view (bypasses DM)
/inv | /i       raw inventory list
/where          show player_at
/save [slot]    save to slot
/slots          list saved slots
/debug          dump KB state + victory/defeat rules
/help | /?      help
/quit | /q      save and exit
```

### Env knobs

| Variable | Default | Notes |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | — | Required. |
| `ADVENTURE_MODEL` | `deepseek-chat` | Any OpenAI-compatible chat model. |
| `ADVENTURE_BASE_URL` | `https://api.deepseek.com/v1` | Swap providers here. |
| `ADVENTURE_TEMPERATURE` | `0.7` | |
| `ADVENTURE_MAX_TOKENS` | `2048` | Per chat request. |
| `ADVENTURE_THEME` | (random) | Pin worldgen to a specific theme. See `THEMES` in `src/dm.ts` for ideas. |
| `ADVENTURE_DEBUG` | unset | Set to log tool-call counts per turn. |

## How it stays consistent

- **Lore is append-only.** `location/3`, `exit/3`, `item_def/4`,
  `character_def/4`, `fact/3`, `scenario/3`, `victory/0`, `defeat/1`
  can be added but never retracted. Once a place exists, its canonical
  description is immutable. Changes are layered through `condition/2`.
- **Mutation is sandboxed.** `state_set` directive bodies must be
  pure `assertz` / `retract` / `retractall` calls on the dynamic
  state predicates. No arithmetic, no side effects.
- **Invariants are checked every turn.** Player must be at a defined
  location, every carried item / placed entity must have a definition,
  every exit must point to a defined location. On failure the model
  gets a structured retry message listing the violations.
- **Worldgen has stricter invariants.** Plus: `scenario/3` must exist,
  at least one `victory/0` clause, at least one in-fiction `defeat/1`
  clause beyond the built-in timeout, `game_status(playing)`,
  `turn_limit ∈ [5, 200]`.

## Persistence

Each slot lives at `saves/<slot>/` as two human-readable Prolog files:

```
saves/default/
  lore.pl     append-only world data (locations, items, NPCs, scenario, ...)
  state.pl    mutable state (player_at, inventory, conditions, stats, ...)
```

Save: rewritten after every turn. Load order is `schema.pl → lore.pl → state.pl`.

⚠️ **Rule-shaped lore (`victory/0` and `defeat/1`) is NOT preserved
across save/load.** The dumper only round-trips facts. Roguelike
runs are designed as single-process sessions (permadeath); resuming
in a fresh process gives you exploration mode without the win/lose
machinery. The CLI prints a warning on load when this happens.

## Project layout

```
src/
  prolog.ts    Persistent SWI-Prolog session (assert, query, dispose)
  schema.pl   Predicate declarations + derived rules + baseline timeout
  world.ts    Typed query helpers (describeCurrent, takeItem, ...)
  persist.ts  .pl save/load
  llm.ts      Tiny OpenAI-compatible HTTP client
  tools.ts    Tool schemas (world_query / world_assert / state_set / narrate / end_turn)
              + validators that enforce the lore-vs-state boundary
  dm.ts      Tool-call REPL — modes: WORLDGEN, PLAY, EPILOGUE
  cli.ts      Player-facing terminal REPL
seeds/
  cottage.pl  5-room debug seed (used by `npm run play -- seed`)
tests/        vitest unit tests
```

## Tests

```bash
npm test           # one-shot run
npm run typecheck  # tsc --noEmit
```
