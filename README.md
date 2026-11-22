# Sokoban solver — make.fun bounty entry

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/duniagelap134/sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/duniagelap134/sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver, 21 November 2026" bounty.

## How it works

The drawn levels have a fixed shape: a one-square hallway across the board, where the player starts, and one to four rooms off it, each in a 6 by 6 slot, opening onto the hallway through one door, holding 3 or 4 boxes and as many goals. A box pushed through a door into the hallway can never be pushed back, so every box stays in its room, and a level's push-optimal count is the sum of its rooms' optima.

`main.ts` exploits exactly that:

1. It splits the level into its rooms (flood fill, cutting the hallway row).
2. It solves each room on its own with a push-based A*: states are the boxes plus the player's reachable region, the estimate is the cheapest matching of boxes to goals (Hungarian), dead states are cut (dead squares, 2 by 2 blocks of boxes and walls), a transposition table keeps the cheapest pushes per state, and the search is cut off by a fixed expansion budget, never the clock — so two runs write identical bytes.
3. It stitches the rooms together with walks along the hallway. Rooms whose optimal solution would trap the player are solved with an exit requirement instead, and the room with the widest gap between its constrained and unconstrained optima goes last, so its gap is never paid.

Solving every room in its optimal push count makes the whole level push-optimal.

## Practice results

Scored with the kit's own scorer on the practice set — **1,000,000** (all five instances at exactly P* pushes):

| instance | pushes | P\* |
| -------- | ------ | --- |
| i001 | 13 | 13 |
| i002 | 16 | 16 |
| i003 | 29 | 29 |
| i004 | 47 | 47 |
| i005 | 60 | 60 |

The house baseline (plain-astar 1.0.0) scores 200,000 on the same set — it solves only i001. The solver also scored 1,000,000 on three freshly drawn sets from the kit's generator (different seeds), each in under a second for the whole set, against the 60-second wall budget.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only, no network. It reads `/input/<id>/level.txt` and writes `/output/<id>/solution.txt` (the player's moves in LURD).
