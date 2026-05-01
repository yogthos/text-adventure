% =====================================================================
% Seed world: a 5-room cottage. Used to verify the schema works
% end-to-end before the LLM is wired in.
% =====================================================================

% ---------- Locations ----------
location(yard,
         'Overgrown Yard',
         'A weed-choked yard stretches before a low stone cottage. The grass swallows your boots, and the air smells of woodsmoke and wet moss. The cottage door stands to the north.').
location(cottage_door,
         'Cottage Door',
         'A heavy oak door, banded in iron. The yard lies south; the cottage interior beckons through the doorway.').
location(cottage_main,
         'Cottage Main Room',
         'The main room of the cottage: a long table, a cold hearth, dust thick as flour. Stairs climb to a low attic, and a trapdoor in the floor descends to a cellar. The doorway out is to the east.').
location(cottage_attic,
         'Cottage Attic',
         'A cramped attic under bare rafters. Pale light leaks through a slat in the roof. The stairs back down are the only way out.').
location(cottage_cellar,
         'Cottage Cellar',
         'A damp earthen cellar, smelling of old wine and mildew. A wooden ladder leads back up.').

% ---------- Exits ----------
exit(yard,           north, cottage_door).
exit(cottage_door,   south, yard).
exit(cottage_door,   in,    cottage_main).
exit(cottage_main,   out,   cottage_door).
exit(cottage_main,   up,    cottage_attic).
exit(cottage_attic,  down,  cottage_main).
exit(cottage_main,   down,  cottage_cellar).
exit(cottage_cellar, up,    cottage_main).

% ---------- Items ----------
item_def(rusty_key,
         'rusty iron key',
         'A pitted iron key, flaked with rust. It looks old enough to open something important.',
         [takeable]).
item_def(oil_lamp,
         'oil lamp',
         'A brass oil lamp. Half-full. The wick is good.',
         [takeable, lit]).
item_def(oak_chest,
         'oak chest',
         'A heavy oak chest, banded in iron. Locked.',
         [container, fixed]).
item_def(table,
         'long table',
         'A long wooden table, scarred by years of use.',
         [fixed]).

% ---------- Characters ----------
character_def(old_man,
              'old man',
              'A grizzled old man in a patched coat, leaning on a walking stick. He watches you with rheumy, knowing eyes.',
              friendly).

% ---------- Lore ----------
fact(rusty_key, opens, oak_chest).
fact(old_man,   knows, cottage_secret).

% ---------- Initial placement ----------
:- assertz(turn_count(0)).
:- assertz(player_at(yard)).
:- assertz(at(old_man, yard)).
:- assertz(at(oil_lamp, cottage_main)).
:- assertz(at(table, cottage_main)).
:- assertz(at(oak_chest, cottage_attic)).
:- assertz(at(rusty_key, cottage_cellar)).
