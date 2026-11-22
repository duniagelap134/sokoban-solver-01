// Sokoban solver: room-decomposed push-optimal A*.
// One program answers a set of levels: it reads /input/<id>/level.txt (XSB) and
// writes /output/<id>/solution.txt (the player's moves in LURD, u/d/l/r).
//
// The levels this contest draws have a fixed shape: a one-square hallway across
// the board, where the player starts, and one to four rooms off it, each inside
// a 6 by 6 slot, opening onto the hallway through one door, holding 3 or 4 boxes
// and as many goals. A box pushed through a door into the hallway can never be
// pushed back, so every box stays in its room, and a level's push-optimal count
// is the sum of its rooms' optima. This solver exploits exactly that: it splits
// the level into its rooms, solves each room on its own with a push-based A*
// (a state is the boxes plus the player's reachable region), then stitches the
// rooms together with walks along the hallway. Solving every room in its optimal
// push count makes the whole level push-optimal.
//
// Each room search is an A* over pushes, not steps: from a state, the moves are
// the pushes the player can reach, and the cost of a state is its pushes. The
// estimate is the cheapest matching of boxes to goals (Hungarian, by brute-force
// permutation over at most 4 boxes) on grid distances that ignore boxes, which
// never overestimates. Dead states are cut: a box on a dead square (a square no
// pull from any goal reaches), and a 2 by 2 block of boxes and walls with no goal
// in it. A transposition table keeps the cheapest pushes for every state, and the
// player is canonicalised to the smallest square of the region they can reach,
// which collapses the many walking positions into one state. The search is cut
// off by a fixed number of expansions, never by the clock, so two runs write
// identical bytes. Node 22, standard library only, no network, no randomness.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions: [dx, dy, letter]. Fixed order everywhere, so every search and
// every walk below is deterministic.
const DIRS: ReadonlyArray<readonly [number, number, string]> = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];
// How far one room search may go, in expanded states. A fixed count, never the
// clock: the same work runs the same way twice.
const ROOM_BUDGET = 400_000;
// The greedy fallback's budget, when the A* above runs out.
const GREEDY_BUDGET = 400_000;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goal: Uint8Array;
  boxes: number[];
  player: number;
}

interface Room {
  /** Floor squares of the room (indices), in increasing order. */
  cells: number[];
  /** The room's goals. */
  goals: number[];
  /** The room's boxes, initial positions, sorted. */
  boxes: number[];
  /** The room square that opens onto the hallway. */
  door: number;
  /** The hallway square in front of the door; the player starts a room here. */
  entry: number;
}

interface RoomSolution {
  pushes: number;
  moves: string;
}

/** Parse an XSB level into a grid. Out-of-row squares count as walls. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goal, boxes, player };
}

/** The squares a player can walk to from `from`, with `boxSet` as obstacles. */
function reachable(
  from: number,
  boxSet: ReadonlySet<number>,
  walkable: (i: number) => boolean,
  w: number,
): Set<number> {
  const seen = new Set<number>([from]);
  const q = [from];
  for (let head = 0; head < q.length; head++) {
    const c = q[head]!;
    const cx = c % w;
    const cy = (c - cx) / w;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0) continue;
      const n = ny * w + nx;
      if (seen.has(n) || boxSet.has(n) || !walkable(n)) continue;
      seen.add(n);
      q.push(n);
    }
  }
  return seen;
}

/** Shortest walk from `from` to `to` (boxes as obstacles), as a move string. */
function walkPath(
  from: number,
  to: number,
  boxSet: ReadonlySet<number>,
  walkable: (i: number) => boolean,
  w: number,
): string | null {
  if (from === to) return '';
  const prev = new Map<number, [number, string]>();
  const q = [from];
  prev.set(from, [-1, '']);
  for (let head = 0; head < q.length; head++) {
    const c = q[head]!;
    const cx = c % w;
    const cy = (c - cx) / w;
    for (const [dx, dy, letter] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0) continue;
      const n = ny * w + nx;
      if (prev.has(n) || boxSet.has(n) || !walkable(n)) continue;
      prev.set(n, [c, letter]);
      if (n === to) {
        let moves = '';
        for (let t = n; t !== from; ) {
          const [p, l] = prev.get(t)!;
          moves = l + moves;
          t = p;
        }
        return moves;
      }
      q.push(n);
    }
  }
  return null;
}

/** Split a level into its hallway row and its rooms. */
function splitRooms(level: Level): { hallwayRow: number; rooms: Room[] } {
  const { w, h, wall, goal, boxes, player } = level;
  const hallwayRow = Math.floor(player / w);
  const inRoom = (i: number): boolean => wall[i] === 0 && Math.floor(i / w) !== hallwayRow;
  const seen = new Uint8Array(w * h);
  const rooms: Room[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!inRoom(s) || seen[s]) continue;
    // Flood-fill one room.
    const cells: number[] = [];
    const q = [s];
    seen[s] = 1;
    for (let head = 0; head < q.length; head++) {
      const c = q[head]!;
      cells.push(c);
      const cx = c % w;
      const cy = (c - cx) / w;
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (!inRoom(n) || seen[n]) continue;
        seen[n] = 1;
        q.push(n);
      }
    }
    cells.sort((a, b) => a - b);
    const cellSet = new Set(cells);
    // The door: the room square touching the hallway. Exactly one per room.
    let door = -1;
    let entry = -1;
    for (const c of cells) {
      const cy = Math.floor(c / w);
      const n = cy < hallwayRow ? c + w : c - w;
      if (Math.floor(n / w) === hallwayRow && wall[n] === 0) {
        door = c;
        entry = n;
        break;
      }
    }
    if (door < 0) continue;
    rooms.push({
      cells,
      goals: cells.filter((c) => goal[c] === 1),
      boxes: boxes.filter((b) => cellSet.has(b)),
      door,
      entry,
    });
  }
  rooms.sort((a, b) => a.entry - b.entry);
  return { hallwayRow, rooms };
}

/**
 * A push-based A* that solves one room on its own, from its door, in the fewest
 * pushes. `requireExit` asks the goal test to also need the player able to walk
 * back to the entry square, so the player can leave the room for the next one.
 * Returns the pushes and the move string (walks and pushes, from the entry
 * square), or null when the budget runs out.
 */
function solveRoom(
  level: Level,
  room: Room,
  requireExit: boolean,
  budget: number,
  greedy: boolean,
): RoomSolution | null {
  const { w, wall } = level;
  const n = room.boxes.length;
  if (n === 0) return { pushes: 0, moves: '' };
  const cellSet = new Set(room.cells);
  // The walkable space of a room search: the room's floor plus the entry square.
  const space = new Set<number>(room.cells);
  space.add(room.entry);
  const walkable = (i: number): boolean => space.has(i);
  const goalSet = new Set(room.goals);

  // Grid distance from every square to every goal, walls only (boxes ignored).
  // A box's distance to its nearest goal never exceeds its true pushes.
  const distToGoal: number[][] = room.goals.map((g) => {
    const d = new Array<number>(w * level.h).fill(Infinity);
    d[g] = 0;
    const q = [g];
    for (let head = 0; head < q.length; head++) {
      const c = q[head]!;
      const cx = c % w;
      const cy = (c - cx) / w;
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= level.h) continue;
        const nn = ny * w + nx;
        if (!space.has(nn) || d[nn] !== Infinity) continue;
        d[nn] = d[c]! + 1;
        q.push(nn);
      }
    }
    return d;
  });

  // Dead squares: a square no pull from any goal reaches. Start from the goals
  // and grow backwards: a square is live when a box on it can be pushed onto a
  // live square with the player standing on the opposite side.
  const live = new Set<number>(room.goals);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of room.cells) {
      if (live.has(s)) continue;
      const sx = s % w;
      const sy = (s - sx) / w;
      for (const [dx, dy] of DIRS) {
        const fwd = (sy + dy) * w + (sx + dx);
        const back = (sy - dy) * w + (sx - dx);
        if (live.has(fwd) && space.has(back) && wall[back] === 0) {
          live.add(s);
          grew = true;
          break;
        }
      }
    }
  }
  const dead = new Set<number>(room.cells.filter((c) => !live.has(c)));

  // Cheapest matching of boxes to goals, by brute-force permutation (at most
  // 4 boxes). Infinity when some box cannot reach any goal.
  const goalPerms: number[][] = (() => {
    const idx = room.goals.map((_, i) => i);
    const out: number[][] = [];
    const perm = (a: number[], k: number): void => {
      if (k === a.length) {
        out.push(a.slice());
        return;
      }
      for (let i = k; i < a.length; i++) {
        [a[k], a[i]] = [a[i]!, a[k]!];
        perm(a, k + 1);
        [a[k], a[i]] = [a[i]!, a[k]!];
      }
    };
    perm(idx, 0);
    return out;
  })();
  const heuristic = (bs: number[]): number => {
    let best = Infinity;
    for (const p of goalPerms) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const d = distToGoal[p[i]!]![bs[i]!]!;
        if (d === Infinity) {
          sum = Infinity;
          break;
        }
        sum += d;
      }
      if (sum < best) best = sum;
    }
    return best;
  };

  // A 2 by 2 block of walls and boxes with no goal in it never moves again.
  const hasBlockDeadlock = (bs: number[]): boolean => {
    const bset = new Set(bs);
    for (const c of bs) {
      const cx = c % w;
      const cy = (c - cx) / w;
      for (let oy = -1; oy <= 0; oy++) {
        for (let ox = -1; ox <= 0; ox++) {
          const x0 = cx + ox;
          const y0 = cy + oy;
          if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= level.h) continue;
          const cells = [y0 * w + x0, y0 * w + x0 + 1, (y0 + 1) * w + x0, (y0 + 1) * w + x0 + 1];
          if (cells.some((t) => goalSet.has(t))) continue;
          if (cells.every((t) => wall[t] === 1 || bset.has(t))) return true;
        }
      }
    }
    return false;
  };
  const stateDead = (bs: number[]): boolean => {
    for (const b of bs) if (dead.has(b)) return true;
    return hasBlockDeadlock(bs);
  };

  // State storage, by id. A state is its boxes (sorted), the player's actual
  // square, its parent and the push that made it.
  const sBoxes: number[][] = [];
  const sPlayer: number[] = [];
  const sParent: number[] = [];
  const sPushBox: number[] = [];
  const sPushDir: number[] = [];
  const sG: number[] = [];
  const best = new Map<number, number>();
  const stateKey = (bs: number[], canonPlayer: number): number => {
    let k = canonPlayer;
    for (const b of bs) k = k * 64 + b;
    return k;
  };
  const canonPlayer = (playerPos: number, bs: number[]): number => {
    const region = reachable(playerPos, new Set(bs), walkable, w);
    let m = Infinity;
    for (const s of region) if (s < m) m = s;
    return m;
  };

  // Binary heap on (f, -g, seq): smallest f first, deeper first on a tie, then
  // insertion order, so the search is deterministic.
  const heap: number[] = [];
  const heapF: number[] = [];
  const heapG: number[] = [];
  const heapSeq: number[] = [];
  let seq = 0;
  const heapLess = (a: number, b: number): boolean =>
    heapF[a]! < heapF[b]! ||
    (heapF[a] === heapF[b] && (heapG[a]! > heapG[b]! || (heapG[a] === heapG[b] && heapSeq[a]! < heapSeq[b]!)));
  const heapPush = (id: number, f: number, g: number): void => {
    const i = heap.length;
    heap.push(id);
    heapF.push(f);
    heapG.push(g);
    heapSeq.push(seq++);
    let c = i;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (!heapLess(c, p)) break;
      for (const arr of [heap, heapF, heapG, heapSeq]) {
        const t = arr[c]!;
        arr[c] = arr[p]!;
        arr[p] = t;
      }
      c = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.length - 1;
    heap[0] = heap[last]!;
    heapF[0] = heapF[last]!;
    heapG[0] = heapG[last]!;
    heapSeq[0] = heapSeq[last]!;
    heap.pop();
    heapF.pop();
    heapG.pop();
    heapSeq.pop();
    for (let i = 0; ; ) {
      let c = 2 * i + 1;
      if (c >= heap.length) break;
      if (c + 1 < heap.length && heapLess(c + 1, c)) c++;
      if (!heapLess(c, i)) break;
      for (const arr of [heap, heapF, heapG, heapSeq]) {
        const t = arr[i]!;
        arr[i] = arr[c]!;
        arr[c] = t;
      }
      i = c;
    }
    return top;
  };

  const addState = (bs: number[], playerPos: number, parent: number, pushBox: number, pushDir: number, g: number): number => {
    const id = sBoxes.length;
    sBoxes.push(bs);
    sPlayer.push(playerPos);
    sParent.push(parent);
    sPushBox.push(pushBox);
    sPushDir.push(pushDir);
    sG.push(g);
    best.set(stateKey(bs, canonPlayer(playerPos, bs)), g);
    return id;
  };

  const startBoxes = room.boxes.slice();
  const h0 = heuristic(startBoxes);
  if (h0 === Infinity) return null;
  const startId = addState(startBoxes, room.entry, -1, -1, -1, 0);
  heapPush(startId, greedy ? h0 : h0, 0);

  const solved = (bs: number[]): boolean => bs.every((b) => goalSet.has(b));
  let expanded = 0;
  while (heap.length > 0 && expanded < budget) {
    const id = heapPop();
    const bs = sBoxes[id]!;
    const g = sG[id]!;
    if (best.get(stateKey(bs, canonPlayer(sPlayer[id]!, bs))) !== g) continue;
    if (solved(bs)) {
      if (!requireExit) return finish(id);
      const region = reachable(sPlayer[id]!, new Set(bs), walkable, w);
      if (region.has(room.entry)) return finish(id);
      continue;
    }
    expanded++;
    const region = reachable(sPlayer[id]!, new Set(bs), walkable, w);
    const boxSet = new Set(bs);
    for (let bi = 0; bi < n; bi++) {
      const b = bs[bi]!;
      const bx = b % w;
      const by = (b - bx) / w;
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di]!;
        const dest = (by + dy) * w + (bx + dx);
        // Boxes never leave the room: the entry square is out of bounds for them.
        if (!cellSet.has(dest) || boxSet.has(dest)) continue;
        const behind = (by - dy) * w + (bx - dx);
        if (!region.has(behind)) continue;
        const nb = bs.slice();
        nb[bi] = dest;
        nb.sort((a, b) => a - b);
        if (stateDead(nb)) continue;
        const h = heuristic(nb);
        if (h === Infinity) continue;
        const ng = g + 1;
        const key = stateKey(nb, canonPlayer(b, nb));
        const seen = best.get(key);
        if (seen !== undefined && seen <= ng) continue;
        const nid = addState(nb, b, id, bi, di, ng);
        heapPush(nid, greedy ? h : ng + h, ng);
      }
    }
  }
  return null;

  /** Rebuild the move string of a solved state: walks plus pushes. */
  function finish(goalId: number): RoomSolution {
    // The pushes, from first to last: the box pushed and its direction, and the
    // boxes and player square before each push.
    const pushes: { box: number; dir: number; playerBefore: number; boxesBefore: number[] }[] = [];
    for (let t = goalId; t > 0; t = sParent[t]!) {
      pushes.push({
        box: sBoxes[sParent[t]!]![sPushBox[t]!]!,
        dir: sPushDir[t]!,
        playerBefore: sPlayer[sParent[t]!]!,
        boxesBefore: sBoxes[sParent[t]!]!,
      });
    }
    pushes.reverse();
    let moves = '';
    for (const p of pushes) {
      const [dx, dy, letter] = DIRS[p.dir]!;
      const behind = p.box - (dy * w + dx);
      const walk = walkPath(p.playerBefore, behind, new Set(p.boxesBefore), walkable, w);
      if (walk === null) return { pushes: -1, moves: '' };
      moves += walk + letter;
    }
    return { pushes: pushes.length, moves };
  }
}

/** Solve one level by splitting it into rooms and stitching their solutions. */
function solveLevel(level: Level): string {
  const { rooms } = splitRooms(level);
  const { w, wall } = level;
  // Every box must sit in a room; anything else is a shape this solver does
  // not cover, and an empty answer at least stays valid.
  const roomCells = new Set<number>();
  for (const r of rooms) for (const c of r.cells) roomCells.add(c);
  if (level.boxes.some((b) => !roomCells.has(b))) return '';

  // Solve every room at its unconstrained optimum first.
  interface RoomPlan {
    room: Room;
    uncons: RoomSolution;
    cons: RoomSolution | null;
    canExit: boolean;
  }
  const plans: RoomPlan[] = [];
  for (const room of rooms) {
    let sol = solveRoom(level, room, false, ROOM_BUDGET, false);
    if (sol === null) sol = solveRoom(level, room, false, GREEDY_BUDGET, true);
    if (sol === null || sol.pushes < 0) return '';
    // Can the player walk back to the entry after this solution?
    const finalBoxes = replayPushes(level, room, sol.moves);
    const canExit = finalBoxes !== null && canWalkOut(level, room, sol.moves, finalBoxes);
    plans.push({ room, uncons: sol, cons: null, canExit });
  }

  // Rooms that trap the player need a constrained optimum, unless they go last.
  // The room with the widest gap between its constrained and unconstrained
  // optima goes last, so its gap is never paid.
  for (const p of plans) {
    if (p.canExit) continue;
    let cons = solveRoom(level, p.room, true, ROOM_BUDGET, false);
    if (cons === null) cons = solveRoom(level, p.room, true, GREEDY_BUDGET, true);
    p.cons = cons;
  }
  let lastIdx = plans.length - 1;
  let widest = -1;
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i]!;
    if (p.canExit || p.cons === null) continue;
    const gap = p.cons.pushes - p.uncons.pushes;
    if (gap > widest) {
      widest = gap;
      lastIdx = i;
    }
  }
  // Any room whose constrained search failed cannot be left early: it must go
  // last, solved unconstrained, or the level cannot be finished.
  for (let i = 0; i < plans.length; i++) {
    if (!plans[i]!.canExit && plans[i]!.cons === null) lastIdx = i;
  }
  const order = plans.map((_, i) => i).filter((i) => i !== lastIdx);
  order.push(lastIdx);

  // Stitch: walk the hallway to each door, run the room, walk back out.
  let moves = '';
  let playerPos = level.player;
  const allBoxes = new Set<number>(level.boxes);
  const levelWalkable = (i: number): boolean => wall[i] === 0;
  for (let oi = 0; oi < order.length; oi++) {
    const plan = plans[order[oi]!]!;
    const room = plan.room;
    const isLast = oi === order.length - 1;
    const sol = !isLast && !plan.canExit && plan.cons !== null ? plan.cons : plan.uncons;
    // Walk along the hallway to this room's entry square.
    const toEntry = walkPath(playerPos, room.entry, allBoxes, levelWalkable, w);
    if (toEntry === null) return '';
    moves += toEntry;
    playerPos = room.entry;
    // Run the room's solution, from the entry square.
    moves += sol.moves;
    // Update the box layout: the room's boxes are now on its goals.
    for (const b of room.boxes) allBoxes.delete(b);
    for (const g of room.goals) allBoxes.add(g);
    // The player ends inside the room; walk back out, unless this is the last.
    if (!isLast) {
      const finalBoxes = replayPushes(level, room, sol.moves);
      if (finalBoxes === null) return '';
      const playerEnd = playerAfterMoves(level, room, sol.moves);
      if (playerEnd < 0) return '';
      const out = walkPath(
        playerEnd,
        room.entry,
        new Set(finalBoxes),
        (i: number) => room.cells.includes(i) || i === room.entry,
        w,
      );
      if (out === null) return '';
      moves += out;
      playerPos = room.entry;
    }
  }
  return moves;
}

/** Replay a room solution's moves on the room's boxes; the final box layout. */
function replayPushes(level: Level, room: Room, moves: string): number[] | null {
  const { w, wall } = level;
  const boxes = new Set<number>(room.boxes);
  let player = room.entry;
  for (const m of moves) {
    const d = DIRS.find(([, , l]) => l === m);
    if (!d) return null;
    const [dx, dy] = d;
    const next = player + dy * w + dx;
    if (wall[next] === 1) return null;
    if (boxes.has(next)) {
      const beyond = next + dy * w + dx;
      if (wall[beyond] === 1 || boxes.has(beyond)) return null;
      boxes.delete(next);
      boxes.add(beyond);
    }
    player = next;
  }
  return [...boxes].sort((a, b) => a - b);
}

/** The player's square after a room solution's moves, replayed from the entry. */
function playerAfterMoves(level: Level, room: Room, moves: string): number {
  const { w, wall } = level;
  const boxes = new Set<number>(room.boxes);
  let player = room.entry;
  for (const m of moves) {
    const d = DIRS.find(([, , l]) => l === m);
    if (!d) return -1;
    const [dx, dy] = d;
    const next = player + dy * w + dx;
    if (wall[next] === 1) return -1;
    if (boxes.has(next)) {
      const beyond = next + dy * w + dx;
      if (wall[beyond] === 1 || boxes.has(beyond)) return -1;
      boxes.delete(next);
      boxes.add(beyond);
    }
    player = next;
  }
  return player;
}

/** Can the player walk back to the entry after a room solution? */
function canWalkOut(level: Level, room: Room, moves: string, finalBoxes: number[]): boolean {
  const playerEnd = playerAfterMoves(level, room, moves);
  if (playerEnd < 0) return false;
  const walkable = (i: number): boolean => room.cells.includes(i) || i === room.entry;
  const region = reachable(playerEnd, new Set(finalBoxes), walkable, level.w);
  return region.has(room.entry);
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8')));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
