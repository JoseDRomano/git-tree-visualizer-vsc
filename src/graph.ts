import { RefInfo, RepoSnapshot } from './types';

export type Mode = 'full' | 'topology';

export interface LayoutCommit {
  hash: string;
  parents: string[];
  /** Per parent: number of commits collapsed between this commit and that parent (topology mode). */
  skipped?: number[];
}

export interface GraphEdge {
  from: number;     // child row
  to: number;       // parent row, -1 when the parent is outside the loaded range
  fromLane: number;
  viaLane: number;  // lane the edge travels down in
  toLane: number;
  color: number;
  hidden: number;   // collapsed commits along this edge
  dashed: boolean;
}

export interface GraphRow {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  subject: string;
  lane: number;
  color: number;
  refs: RefInfo[];
  worktrees: number[]; // indices into snapshot.worktrees whose HEAD is this commit
  isHead: boolean;
  wip?: { worktree: number; changes: number };
}

export interface GraphPayload {
  rows: GraphRow[];
  edges: GraphEdge[];
  laneCount: number;
}

/**
 * Assigns each commit (in child-before-parent order) to a lane and computes the edges.
 * A lane is reserved for the commit it is waiting for, so vertical edge segments never
 * cross a node; edges bend only in the row right after the child or right before the parent.
 */
export function layout(commits: LayoutCommit[]): { nodes: { lane: number; color: number }[]; edges: GraphEdge[]; laneCount: number } {
  const rowOf = new Map<string, number>();
  commits.forEach((c, i) => rowOf.set(c.hash, i));

  const lanes: ({ hash: string; color: number } | null)[] = [];
  const nodes: { lane: number; color: number }[] = [];
  const edges: GraphEdge[] = [];
  let nextColor = 0;
  let laneCount = 0;

  const freeLane = () => {
    const i = lanes.indexOf(null);
    if (i >= 0) return i;
    lanes.push(null);
    return lanes.length - 1;
  };

  commits.forEach((c, row) => {
    let lane = -1;
    const converging: number[] = [];
    lanes.forEach((l, i) => {
      if (l && l.hash === c.hash) {
        if (lane < 0) lane = i;
        else converging.push(i);
      }
    });

    let color: number;
    if (lane < 0) {
      lane = freeLane();
      color = nextColor++;
    } else {
      color = lanes[lane]!.color;
    }
    lanes[lane] = null;
    nodes.push({ lane, color });

    c.parents.forEach((p, k) => {
      const hidden = c.skipped?.[k] ?? 0;
      if (!rowOf.has(p)) {
        edges.push({ from: row, to: -1, fromLane: lane, viaLane: lane, toLane: lane, color, hidden, dashed: false });
        return;
      }
      let via = lanes.findIndex(l => l?.hash === p);
      if (via < 0) {
        if (k === 0 && lanes[lane] === null) {
          via = lane;
          lanes[via] = { hash: p, color };
        } else {
          via = freeLane();
          lanes[via] = { hash: p, color: nextColor++ };
        }
      }
      edges.push({ from: row, to: rowOf.get(p)!, fromLane: lane, viaLane: via, toLane: -1, color: lanes[via]!.color, hidden, dashed: false });
    });

    // Free lanes that merged into this commit only now, so new parents don't reuse them in the same row.
    for (const i of converging) lanes[i] = null;
    laneCount = Math.max(laneCount, lanes.length);
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
  });

  for (const e of edges) if (e.to >= 0) e.toLane = nodes[e.to].lane;
  return { nodes, edges, laneCount };
}

/**
 * Keeps only "interesting" commits (anything in `keep`, merges, forks, roots, boundary commits)
 * and rewrites parents to skip over linear runs, recording how many commits were skipped.
 */
export function compress(commits: LayoutCommit[], keep: Set<string>): LayoutCommit[] {
  const byHash = new Map(commits.map(c => [c.hash, c]));
  const children = new Map<string, number>();
  for (const c of commits) for (const p of c.parents) children.set(p, (children.get(p) ?? 0) + 1);

  const kept = new Set<string>();
  for (const c of commits) {
    if (keep.has(c.hash) || c.parents.length !== 1 || children.get(c.hash) !== 1 || !byHash.has(c.parents[0])) {
      kept.add(c.hash);
    }
  }

  const follow = (p: string) => {
    let n = 0;
    while (byHash.has(p) && !kept.has(p)) {
      n++;
      p = byHash.get(p)!.parents[0];
    }
    return { p, n };
  };

  // Two parents of a merge collapsing onto the same commit would hide the branch "bubble";
  // keep the first commit of the duplicate run so both sides stay visible.
  for (let changed = true; changed;) {
    changed = false;
    for (const c of commits) {
      if (!kept.has(c.hash) || c.parents.length < 2) continue;
      const seen = new Set<string>();
      for (const p0 of c.parents) {
        const { p } = follow(p0);
        if (seen.has(p) && !kept.has(p0)) {
          kept.add(p0);
          changed = true;
        }
        seen.add(p);
      }
    }
  }

  return commits
    .filter(c => kept.has(c.hash))
    .map(c => {
      const parents: string[] = [];
      const skipped: number[] = [];
      for (const p0 of c.parents) {
        const { p, n } = follow(p0);
        parents.push(p);
        skipped.push(n);
      }
      return { hash: c.hash, parents, skipped };
    });
}

export function buildGraph(snap: RepoSnapshot, mode: Mode): GraphPayload {
  const commitByHash = new Map(snap.commits.map(c => [c.hash, c]));

  const refsByHash = new Map<string, RefInfo[]>();
  for (const r of snap.refs) {
    if (!commitByHash.has(r.hash)) continue;
    const list = refsByHash.get(r.hash) ?? [];
    list.push(r);
    refsByHash.set(r.hash, list);
  }
  const kindOrder = { branch: 0, remote: 1, tag: 2 };
  for (const list of refsByHash.values()) {
    list.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.name.localeCompare(b.name));
  }

  const wtByHash = new Map<string, number[]>();
  snap.worktrees.forEach((w, i) => {
    if (!w.head || w.bare) return;
    const list = wtByHash.get(w.head) ?? [];
    list.push(i);
    wtByHash.set(w.head, list);
  });

  // Virtual "uncommitted changes" rows, one per dirty worktree, current worktree first.
  const wipIds = new Map<string, number>();
  const wipCommits: LayoutCommit[] = [];
  snap.worktrees
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => w.dirty > 0 && w.head && commitByHash.has(w.head))
    .sort((a, b) => Number(b.w.isCurrent) - Number(a.w.isCurrent))
    .forEach(({ w, i }) => {
      const id = `~wip:${i}`;
      wipIds.set(id, i);
      wipCommits.push({ hash: id, parents: [w.head!] });
    });

  let list: LayoutCommit[] = [...wipCommits, ...snap.commits];
  if (mode === 'topology') {
    const keep = new Set<string>([...refsByHash.keys(), ...wtByHash.keys(), ...wipIds.keys()]);
    if (snap.head) keep.add(snap.head);
    list = compress(list, keep);
  }

  const { nodes, edges, laneCount } = layout(list);

  const rows: GraphRow[] = list.map((lc, i) => {
    const wi = wipIds.get(lc.hash);
    if (wi !== undefined) {
      const w = snap.worktrees[wi];
      return {
        hash: lc.hash, short: '', parents: lc.parents, author: '', email: '', time: 0,
        subject: 'Uncommitted changes', lane: nodes[i].lane, color: nodes[i].color,
        refs: [], worktrees: [], isHead: false, wip: { worktree: wi, changes: w.dirty },
      };
    }
    const c = commitByHash.get(lc.hash)!;
    return {
      hash: c.hash, short: c.short, parents: lc.parents, author: c.author, email: c.email,
      time: c.time, subject: c.subject, lane: nodes[i].lane, color: nodes[i].color,
      refs: refsByHash.get(c.hash) ?? [], worktrees: wtByHash.get(c.hash) ?? [],
      isHead: c.hash === snap.head,
    };
  });

  for (const e of edges) if (rows[e.from].wip) e.dashed = true;
  return { rows, edges, laneCount };
}
