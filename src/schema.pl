% =====================================================================
% World schema for the text-adventure DM.
%
% Two tiers:
%   - LORE      : append-only facts asserted once at generation time.
%   - STATE     : mutable; asserted/retracted as the game progresses.
%
% Derived predicates at the bottom are pure rules — they query the two
% tiers but never mutate. The DM's narration must be consistent with
% what these rules return.
% =====================================================================

% ---------- LORE (append-only) ----------
%
% multifile + dynamic: clauses for these predicates can accumulate
% across many consulted files (one per world_assert call), and we can
% still query/retract at runtime. Without `multifile`, SWI's default
% "consult replaces clauses" behaviour would abolish prior lore every
% time the DM adds a new location.
%
% The append-only guarantee is enforced one layer up: the world_assert
% validator rejects any retract directive, so the DM can only ever
% add, never remove, lore.
:- multifile location/3.
:- multifile exit/3.
:- multifile item_def/4.
:- multifile character_def/4.
:- multifile fact/3.
:- dynamic location/3.
:- dynamic exit/3.
:- dynamic item_def/4.
:- dynamic character_def/4.
:- dynamic fact/3.
:- discontiguous location/3.
:- discontiguous exit/3.
:- discontiguous item_def/4.
:- discontiguous character_def/4.
:- discontiguous fact/3.

% location(Id, ShortName, OriginalLongDesc).
%   The original first-time description. Never retracted. On revisit,
%   the DM gets this back as the canonical baseline; mutations are
%   layered via condition/2.
%
% exit(FromLocId, Direction, ToLocId).
%   Direction is an atom: north, south, east, west, up, down, in, out, ...
%
% item_def(Id, Name, Desc, Tags).
%   Tags is a list. Recognised: takeable, container, weapon, lit,
%   hidden, fixed, readable.
%
% character_def(Id, Name, Desc, Disposition).
%   Disposition: friendly | neutral | wary | hostile (initial only;
%   live disposition lives in npc_state/2).
%
% fact(Subject, Predicate, Object).
%   Free-form lore triples. e.g.
%     fact(king_alric, killed_by, dragon).
%     fact(rusty_key, opens, oak_chest).

% ---------- SCENARIO LORE (asserted once at worldgen) ----------
%
% scenario(SettingAtom, PremiseString, GoalString).
%   - SettingAtom: short snake_case label (lighthouse_storm, vault_heist, ...).
%   - PremiseString: 1-3 sentence framing the situation.
%   - GoalString: one sentence stating the player's objective.
%
% victory.
%   A *rule* (or fact) defining when the player wins. Multiple clauses
%   allowed; succeeding any one triggers victory. e.g.
%     victory :- player_has(crown), player_at(throne_room).
%
% defeat(Reason).
%   Rule(s) defining loss conditions. The Reason atom labels the cause
%   for the closing narration. e.g.
%     defeat(starved) :- player_stat(hunger, H), H >= 100.
%     defeat(timeout) is built in below — see "baseline rules".
:- multifile scenario/3, victory/0, defeat/1.
:- dynamic    scenario/3, victory/0, defeat/1.
:- discontiguous scenario/3, victory/0, defeat/1.

% ---------- STATE (mutable) ----------
:- dynamic player_at/1.
:- dynamic player_has/1.
:- dynamic at/2.            % at(EntityId, LocId)  — items and NPCs
:- dynamic visited/1.        % visited(LocId)
:- dynamic npc_state/2.      % npc_state(CharId, KeyValueList)
:- dynamic flag/1.           % flag(Atom)  — boolean world flags
:- dynamic condition/2.      % condition(LocId, DescAtomOrString)
                             %   layered changes since first visit;
                             %   e.g. condition(cottage, burned).
:- dynamic turn_count/1.
:- dynamic event_log/2.      % event_log(Turn, Description)
:- dynamic player_stat/2.    % player_stat(Key, Value)  — health/hunger/etc.
:- dynamic game_status/1.    % playing | won | lost(ReasonAtom)
:- dynamic turn_limit/1.     % roguelike soft cap; defeat(timeout) fires when exceeded

% ---------- Baseline rules ----------
% Always-on timeout defeat. The DM can omit it from worldgen; this
% clause guarantees runs end if the turn budget is blown past.
defeat(timeout) :- turn_count(N), turn_limit(L), N >= L.

% ---------- Derived rules ----------
% Visible / takeable items at the player's current location.
visible_item(I) :-
    player_at(L),
    at(I, L),
    item_def(I, _, _, Tags),
    \+ member(hidden, Tags).

takeable_item(I) :-
    visible_item(I),
    item_def(I, _, _, Tags),
    member(takeable, Tags).

% NPC present in the current room.
present_npc(C) :-
    player_at(L),
    at(C, L),
    character_def(C, _, _, _).

% Exits available from the current room. Bound or unbound directions
% both work as queries.
exit_here(D, To) :-
    player_at(L),
    exit(L, D, To).

known_destination(D) :-
    exit_here(D, To),
    location(To, _, _).

unknown_destination(D) :-
    exit_here(D, To),
    \+ location(To, _, _).

% Has the player been here before?
already_visited(L) :- visited(L).

% Conditions accumulated for a location (in assertion order).
location_conditions(L, Cs) :- findall(C, condition(L, C), Cs).
