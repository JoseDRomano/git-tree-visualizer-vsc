import { RefInfo, RepoSnapshot } from './types';

export type LimbKind = 'trunk' | 'branch' | 'remote' | 'detached';

export interface TreeLimb {
  id: number;            // limbs[0] is the trunk
  kind: LimbKind;
  local: boolean;        // names[0] is a local branch (so it can be merged into)
  names: string[];       // all refs pointing at the tip
  tip: string;
  short: string;
  subject: string;
  author: string;
  time: number;
  parent: number;        // parent limb id, -1 for the trunk
  forkIdx: number;       // position on the parent's first-parent chain (0 = parent tip)
  forkHash?: string;
  forkShort?: string;
  forkKnown: boolean;    // false when the fork point is older than the loaded history
  ahead: number;         // first-parent commits on this limb
  behind: number;        // commits the parent limb gained since the fork
  mergedAt?: number;     // trunk index of the commit that made this tip reachable from the trunk
  upstream?: { name: string; ahead: number; behind: number; gone: boolean };
  worktrees: number[];
  isHead: boolean;
  tags: string[];
}

export interface TrunkEvent {
  idx: number;           // 0 = trunk tip
  hash: string;
  short: string;
  subject: string;
  author: string;
  time: number;
  tags: string[];
  worktrees: number[];
  merge: boolean;
  root: boolean;         // has no parents
  boundary: boolean;     // oldest loaded commit, but history continues
}

export interface BranchTree {
  trunkName: string;
  trunkLength: number;
  events: TrunkEvent[];
  limbs: TreeLimb[];
  candidates: string[];  // names selectable as trunk
}

interface Candidate {
  hash: string;
  names: string[];
  kind: LimbKind;
  upstream?: RefInfo;
}

function remoteBranchName(remote: string): string {
  return remote.slice(remote.indexOf('/') + 1);
}

/** `production` is the branch the tree grows around; when unset or missing it is detected. */
export function buildBranchTree(snap: RepoSnapshot, production?: string): BranchTree | null {
  const byHash = new Map(snap.commits.map(c => [c.hash, c]));
  const locals = snap.refs.filter(r => r.kind === 'branch' && byHash.has(r.hash));
  const remotes = snap.refs.filter(r => r.kind === 'remote' && byHash.has(r.hash));
  const candidates = [...locals, ...remotes].map(r => r.name);

  const tagsByHash = new Map<string, string[]>();
  for (const r of snap.refs) {
    if (r.kind !== 'tag') continue;
    tagsByHash.set(r.hash, [...(tagsByHash.get(r.hash) ?? []), r.name]);
  }
  /** Worktrees with `hash` checked out: on the branch `name`, or detached when no name is given. */
  const worktreesAt = (hash: string, name?: string) => snap.worktrees.flatMap((w, i) =>
    !w.bare && w.head === hash && (name === undefined ? w.detached : w.branch === name) ? [i] : []);

  // ---- trunk ----
  const all = [...locals, ...remotes];
  const find = (name?: string) => (name ? all.find(r => r.name === name) : undefined);
  const trunkRef =
    find(production) ??
    find(snap.defaultBranch && remoteBranchName(snap.defaultBranch)) ??
    find('main') ?? find('master') ?? find('trunk') ?? find('develop') ??
    find(snap.headBranch) ?? locals[0] ?? find(snap.defaultBranch);
  const trunkTip = trunkRef?.hash ?? (snap.head && byHash.has(snap.head) ? snap.head : undefined);
  if (!trunkTip) return null;
  const trunkName = trunkRef?.name ?? 'HEAD';

  const owner = new Map<string, { limb: number; idx: number }>();
  const trunkChain: string[] = [];
  for (let h: string | undefined = trunkTip; h && byHash.has(h) && !owner.has(h); h = byHash.get(h)!.parents[0]) {
    owner.set(h, { limb: 0, idx: trunkChain.length });
    trunkChain.push(h);
  }

  // For every commit, the trunk index at which it became reachable from the trunk (via merges).
  const reachedAt = new Map<string, number>();
  for (let i = trunkChain.length - 1; i >= 0; i--) {
    const c = byHash.get(trunkChain[i])!;
    reachedAt.set(c.hash, i);
    const stack = c.parents.slice(1);
    while (stack.length) {
      const h = stack.pop()!;
      if (reachedAt.has(h) || !byHash.has(h)) continue;
      reachedAt.set(h, i);
      stack.push(...byHash.get(h)!.parents);
    }
  }

  const upstreamOf = (r?: RefInfo) =>
    r?.upstream ? { name: r.upstream, ahead: r.ahead ?? 0, behind: r.behind ?? 0, gone: !!r.gone } : undefined;

  const tipCommit = byHash.get(trunkTip)!;
  const trunkNames = trunkRef ? [trunkName] : [];
  const trunkLimb: TreeLimb = {
    id: 0, kind: 'trunk', local: trunkRef?.kind === 'branch', names: trunkNames, tip: trunkTip, short: tipCommit.short, subject: tipCommit.subject,
    author: tipCommit.author, time: tipCommit.time, parent: -1, forkIdx: 0, forkKnown: true,
    ahead: trunkChain.length, behind: 0, upstream: upstreamOf(trunkRef?.kind === 'branch' ? trunkRef : undefined),
    worktrees: [...worktreesAt(trunkTip, trunkName), ...worktreesAt(trunkTip)], isHead: false, tags: tagsByHash.get(trunkTip) ?? [],
  };

  // ---- candidate tips: every branch gets its own, even when several point at the same commit ----
  const cands: Candidate[] = [];
  const add = (hash: string, name: string, kind: LimbKind, upstream?: RefInfo) => {
    cands.push({ hash, names: [name], kind, upstream });
  };
  for (const b of locals) if (b.name !== trunkName) add(b.hash, b.name, 'branch', b);
  const trunkUpstream = trunkRef?.kind === 'branch' ? trunkRef.upstream : undefined;
  for (const r of remotes) {
    if (r.name === trunkName || r.name === trunkUpstream) continue;
    const tracked = locals.some(b => b.upstream === r.name || b.name === remoteBranchName(r.name));
    if (!tracked) add(r.hash, r.name, 'remote');
  }
  for (const w of snap.worktrees) {
    // Detached worktrees off the trunk get their own limb; on the trunk they are just markers.
    if (w.detached && w.head && byHash.has(w.head) && !cands.some(c => c.hash === w.head) && !owner.has(w.head)) {
      add(w.head, 'detached HEAD', 'detached');
    }
  }

  // ---- assign commits to limbs ----
  // Git doesn't record which branch grew from which, so shared commits go to (in order):
  // named branches before remote-only ones before detached HEADs, then the longest unowned run,
  // except that "feature/x" claims them before "feature/x-more" when both leave from the same spot.
  // A branch whose tip is already claimed (it points at the same commit as another) becomes a
  // zero-length limb growing from that commit.
  const walk = (h: string | undefined) => {
    const chain: string[] = [];
    while (h && byHash.has(h) && !owner.has(h)) {
      chain.push(h);
      h = byHash.get(h)!.parents[0];
    }
    return { chain, fork: h && owner.has(h) ? h : undefined };
  };
  const rank: Record<LimbKind, number> = { trunk: 0, branch: 0, remote: 1, detached: 2 };
  const extendsName = (child: Candidate, parent: Candidate) =>
    child.names.some(n => parent.names.some(p => n.startsWith(p + '-') || n.startsWith(p + '/') || n.startsWith(p + '_')));

  const limbs: TreeLimb[] = [trunkLimb];
  const pending = [...cands];
  while (pending.length) {
    const walks = pending.map(c => walk(c.hash));
    let best = 0;
    for (let i = 1; i < pending.length; i++) {
      const dr = rank[pending[i].kind] - rank[pending[best].kind];
      if (dr < 0 || (dr === 0 && walks[i].chain.length > walks[best].chain.length)) best = i;
    }
    const prefixParent = pending.findIndex((c, i) =>
      i !== best && rank[c.kind] === rank[pending[best].kind] && walks[i].fork === walks[best].fork &&
      walks[i].chain.length > 0 && extendsName(pending[best], c));
    if (prefixParent >= 0) best = prefixParent;
    const bestWalk = walks[best];
    const cand = pending.splice(best, 1)[0];
    const id = limbs.length;
    bestWalk.chain.forEach((h, idx) => owner.set(h, { limb: id, idx }));
    const fork = bestWalk.fork ? owner.get(bestWalk.fork)! : undefined;
    const c = byHash.get(cand.hash)!;
    const onTrunk = owner.get(cand.hash)?.limb === 0;
    // Each worktree belongs to the branch it has checked out, not to every branch on that commit.
    const wts = cand.kind === 'detached' ? worktreesAt(cand.hash) : worktreesAt(cand.hash, cand.names[0]);
    limbs.push({
      id,
      kind: cand.kind,
      local: cand.kind === 'branch',
      names: cand.names,
      tip: c.hash,
      short: c.short,
      subject: c.subject,
      author: c.author,
      time: c.time,
      parent: fork ? fork.limb : 0,
      forkIdx: fork ? fork.idx : trunkChain.length - 1,
      forkHash: bestWalk.fork,
      forkShort: bestWalk.fork ? byHash.get(bestWalk.fork)!.short : undefined,
      forkKnown: !!fork,
      ahead: bestWalk.chain.length,
      behind: fork ? fork.idx : 0,
      mergedAt: onTrunk ? undefined : reachedAt.get(cand.hash),
      upstream: upstreamOf(cand.upstream),
      worktrees: wts,
      isHead: (!!snap.headBranch && cand.names.includes(snap.headBranch)) ||
        (cand.kind === 'detached' && wts.some(wi => snap.worktrees[wi].isCurrent)),
      tags: tagsByHash.get(cand.hash) ?? [],
    });
  }
  trunkLimb.isHead = !!snap.headBranch && trunkLimb.names.includes(snap.headBranch);

  // ---- trunk events: places on the trunk worth marking ----
  const evIdx = new Set<number>([0, trunkChain.length - 1]);
  for (const l of limbs) {
    if (l.id > 0 && l.parent === 0) evIdx.add(l.forkIdx);
    if (l.mergedAt !== undefined) evIdx.add(l.mergedAt);
  }
  trunkChain.forEach((h, i) => {
    if (tagsByHash.has(h) || worktreesAt(h).length) evIdx.add(i);
  });
  const events: TrunkEvent[] = [...evIdx].sort((a, b) => a - b).map(idx => {
    const c = byHash.get(trunkChain[idx])!;
    return {
      idx, hash: c.hash, short: c.short, subject: c.subject, author: c.author, time: c.time,
      tags: tagsByHash.get(c.hash) ?? [], worktrees: worktreesAt(c.hash),
      merge: c.parents.length > 1, root: c.parents.length === 0,
      boundary: idx === trunkChain.length - 1 && c.parents.length > 0,
    };
  });

  return { trunkName, trunkLength: trunkChain.length, events, limbs, candidates };
}
