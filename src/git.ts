import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Commit, LoadOptions, RefInfo, RepoSnapshot, Worktree } from './types';

let gitPath = 'git';

export function setGitPath(p: string | undefined): void {
  gitPath = p && p.trim() ? p : 'git';
}

interface RawResult {
  code: number; // -1 when git could not be run at all
  stdout: string;
  stderr: string;
}

/** Runs git and resolves with its exit code instead of rejecting on failure. */
function gitRaw(cwd: string, args: string[], timeout = 60_000): Promise<RawResult> {
  return new Promise(resolve => {
    execFile(
      gitPath,
      ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
      // GIT_OPTIONAL_LOCKS=0 keeps `git status` from rewriting the index (and re-triggering our watcher).
      { cwd, maxBuffer: 512 * 1024 * 1024, timeout, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (err, stdout, stderr) => {
        const code = !err ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1;
        resolve({ code, stdout, stderr: stderr || (err && code === -1 ? err.message : '') });
      }
    );
  });
}

async function git(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  const r = await gitRaw(cwd, args, timeout);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} failed (exit ${r.code})`);
  return r.stdout;
}

function realpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

export async function findRepoRoot(dir: string): Promise<string | undefined> {
  try {
    const out = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    return out ? realpath(out) : undefined;
  } catch {
    return undefined;
  }
}

export async function getCommonDir(root: string): Promise<string> {
  const out = (await git(root, ['rev-parse', '--git-common-dir'])).trim();
  return realpath(path.resolve(root, out));
}

export function parseWorktrees(out: string, currentRoot: string): Worktree[] {
  const current = realpath(currentRoot);
  const blocks = out.split(/\n\n+/).map(b => b.trim()).filter(Boolean);
  return blocks.map((block, i) => {
    const wt: Worktree = {
      path: '',
      name: '',
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
      isMain: i === 0,
      isCurrent: false,
      dirty: 0,
    };
    for (const line of block.split('\n')) {
      const sp = line.indexOf(' ');
      const key = sp < 0 ? line : line.slice(0, sp);
      const value = sp < 0 ? '' : line.slice(sp + 1);
      switch (key) {
        case 'worktree': wt.path = value; break;
        case 'HEAD': wt.head = value; break;
        case 'branch': wt.branch = value.replace(/^refs\/heads\//, ''); break;
        case 'detached': wt.detached = true; break;
        case 'bare': wt.bare = true; break;
        case 'locked': wt.locked = true; break;
        case 'prunable': wt.prunable = true; break;
      }
    }
    wt.name = path.basename(wt.path);
    wt.isCurrent = realpath(wt.path) === current;
    return wt;
  });
}

export function parseRefs(out: string): RefInfo[] {
  const refs: RefInfo[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [obj, peeled, full, upstream, track] = line.split('\0');
    const hash = peeled || obj;
    let ref: RefInfo;
    if (full.startsWith('refs/heads/')) {
      ref = { name: full.slice(11), kind: 'branch', hash };
      if (upstream) {
        ref.upstream = upstream;
        ref.gone = track === 'gone';
        ref.ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0);
        ref.behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0);
      }
    } else if (full.startsWith('refs/remotes/')) {
      if (full.endsWith('/HEAD')) continue;
      ref = { name: full.slice(13), kind: 'remote', hash };
    } else if (full.startsWith('refs/tags/')) {
      ref = { name: full.slice(10), kind: 'tag', hash };
    } else {
      continue;
    }
    refs.push(ref);
  }
  return refs;
}

export function parseLog(out: string): Commit[] {
  const commits: Commit[] = [];
  for (const rec of out.split('\x1e')) {
    const r = rec.replace(/^\n+/, '');
    if (!r) continue;
    const [hash, short, parents, author, email, time, subject] = r.split('\x1f');
    commits.push({
      hash,
      short,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      time: Number(time),
      subject: subject ?? '',
    });
  }
  return commits;
}

async function countChanges(wtPath: string): Promise<number> {
  try {
    const out = await git(wtPath, ['status', '--porcelain=v1', '--untracked-files=normal'], 15_000);
    return out.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

export async function loadSnapshot(root: string, opts: LoadOptions): Promise<RepoSnapshot> {
  const [wtOut, refOut, head, headBranch, defaultBranch] = await Promise.all([
    git(root, ['worktree', 'list', '--porcelain']).catch(() => ''),
    git(root, [
      'for-each-ref',
      '--format=%(objectname)%00%(*objectname)%00%(refname)%00%(upstream:short)%00%(upstream:track,nobracket)',
      'refs/heads', 'refs/remotes', 'refs/tags',
    ]),
    git(root, ['rev-parse', '--verify', '-q', 'HEAD']).then(s => s.trim() || undefined, () => undefined),
    git(root, ['symbolic-ref', '-q', '--short', 'HEAD']).then(s => s.trim() || undefined, () => undefined),
    git(root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']).then(s => s.trim() || undefined, () => undefined),
  ]);

  const worktrees = parseWorktrees(wtOut, root);
  const refs = parseRefs(refOut).filter(r => (r.kind !== 'remote' || opts.remotes) && (r.kind !== 'tag' || opts.tags));

  await Promise.all(
    worktrees
      .filter(w => !w.bare && !w.prunable && fs.existsSync(w.path))
      .map(async w => { w.dirty = await countChanges(w.path); })
  );

  // Explicitly include every worktree HEAD so detached worktrees show up too.
  const revs = new Set<string>();
  if (head) revs.add('HEAD');
  for (const w of worktrees) if (w.head && !w.bare) revs.add(w.head);
  const args = ['log', '--date-order', `--max-count=${opts.maxCommits + 1}`,
    '--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1e', '--branches'];
  if (opts.remotes) args.push('--remotes');
  if (opts.tags) args.push('--tags');

  let commits: Commit[] = [];
  if (refs.length || revs.size) {
    commits = parseLog(await git(root, [...args, ...revs, '--']));
  }
  const truncated = commits.length > opts.maxCommits;
  if (truncated) commits.length = opts.maxCommits;

  return { root, name: path.basename(root), commits, refs, worktrees, head, headBranch, defaultBranch, truncated };
}

export interface FileChange { status: string; path: string; added?: number; deleted?: number; }

export interface CommitDetails {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  authorTime: number;
  committer: string;
  commitTime: number;
  body: string;
  files: FileChange[];
}

export async function getCommitDetails(root: string, hash: string): Promise<CommitDetails> {
  const out = await git(root, [
    'show', '--no-color', '-M', '--diff-merges=first-parent', '--numstat',
    '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%B%x1e', hash, '--',
  ]);
  const sep = out.indexOf('\x1e');
  const [h, parents, author, email, at, cn, ct, body] = out.slice(0, sep).split('\x1f');
  const files: FileChange[] = [];
  for (const line of out.slice(sep + 1).split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(line);
    if (!m) continue;
    files.push({
      status: m[3].includes(' => ') ? 'R' : 'M',
      path: m[3],
      added: m[1] === '-' ? undefined : Number(m[1]),
      deleted: m[2] === '-' ? undefined : Number(m[2]),
    });
  }
  return {
    hash: h, parents: parents ? parents.split(' ') : [], author, email,
    authorTime: Number(at), committer: cn, commitTime: Number(ct), body: (body ?? '').trim(), files,
  };
}

export async function getWorktreeChanges(wtPath: string): Promise<FileChange[]> {
  const out = await git(wtPath, ['status', '--porcelain=v1', '--untracked-files=normal']);
  return out.split('\n').filter(Boolean).map(l => ({ status: l.slice(0, 2).trim() || '?', path: l.slice(3) }));
}

// ---------- merging ----------

export interface MergePreview {
  source: string;
  target: string;
  sourceHash: string;
  targetHash: string;
  base?: string;             // merge base, undefined for unrelated histories
  incoming: number;          // commits the target would gain
  targetOnly: number;        // commits only the target has
  upToDate: boolean;         // target already contains source
  fastForward: boolean;
  files: number;
  added: number;
  deleted: number;
  conflicts: string[] | null; // conflicting paths; null when they could not be checked
  commits: { short: string; subject: string }[];
  worktree?: { name: string; path: string; dirty: number }; // where the target is checked out
}

export async function getMergePreview(root: string, source: string, target: string, worktrees: Worktree[]): Promise<MergePreview> {
  const rev = async (r: string) => (await git(root, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`])).trim();
  const [sourceHash, targetHash] = await Promise.all([rev(source), rev(target)]);
  const baseRes = await gitRaw(root, ['merge-base', targetHash, sourceHash]);
  const base = baseRes.code === 0 ? baseRes.stdout.trim() : undefined;

  const [counts, log, numstat] = await Promise.all([
    git(root, ['rev-list', '--left-right', '--count', `${targetHash}...${sourceHash}`]),
    git(root, ['log', '--format=%h%x1f%s', '-n', '6', `${targetHash}..${sourceHash}`]),
    base ? git(root, ['diff', '--numstat', '-M', base, sourceHash]) : Promise.resolve(''),
  ]);
  const [targetOnly, incoming] = counts.trim().split(/\s+/).map(Number);
  const upToDate = incoming === 0;
  const fastForward = !upToDate && targetOnly === 0;

  let files = 0, added = 0, deleted = 0;
  for (const line of numstat.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) continue;
    files++;
    if (m[1] !== '-') added += Number(m[1]);
    if (m[2] !== '-') deleted += Number(m[2]);
  }

  let conflicts: string[] | null = [];
  if (!upToDate && !fastForward) {
    // merge-tree (git 2.38+) does the merge in memory: exit 0 = clean, 1 = conflicts.
    const mt = await gitRaw(root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', targetHash, sourceHash]);
    conflicts = mt.code === 0 ? [] : mt.code === 1 ? [...new Set(mt.stdout.split('\n').slice(1).filter(Boolean))] : null;
  }

  const wt = worktrees.find(w => w.branch === target && !w.bare && !w.prunable);
  return {
    source, target, sourceHash, targetHash, base, incoming, targetOnly, upToDate, fastForward,
    files, added, deleted, conflicts,
    commits: log.split('\n').filter(Boolean).map(l => {
      const [short, subject] = l.split('\x1f');
      return { short, subject };
    }),
    worktree: wt ? { name: wt.name, path: wt.path, dirty: wt.dirty } : undefined,
  };
}

export type MergeStatus = 'merged' | 'fast-forward' | 'up-to-date' | 'conflicts';

/**
 * Merges `source` into the local branch `target`. When the target is checked out in a worktree the
 * merge runs there (conflicts are left for the user to resolve); otherwise only clean merges are
 * allowed and the branch ref is moved directly, guarded against concurrent changes.
 */
export async function performMerge(
  root: string, source: string, target: string, worktrees: Worktree[]
): Promise<{ status: MergeStatus; worktree?: string }> {
  const p = await getMergePreview(root, source, target, worktrees);
  if (p.upToDate) return { status: 'up-to-date' };

  if (p.worktree) {
    if (await countChanges(p.worktree.path)) {
      throw new Error(`'${target}' is checked out in ${p.worktree.name}, which has uncommitted changes. Commit or stash them first.`);
    }
    const r = await gitRaw(p.worktree.path, ['merge', '--no-edit', source]);
    if (r.code === 0) return { status: p.fastForward ? 'fast-forward' : 'merged', worktree: p.worktree.path };
    const unmerged = await gitRaw(p.worktree.path, ['diff', '--name-only', '--diff-filter=U']);
    if (unmerged.stdout.trim()) return { status: 'conflicts', worktree: p.worktree.path };
    throw new Error(r.stderr.trim() || r.stdout.trim() || 'git merge failed');
  }

  const ref = `refs/heads/${target}`;
  if (p.fastForward) {
    await git(root, ['update-ref', '-m', `merge ${source}: Fast-forward`, ref, p.sourceHash, p.targetHash]);
    return { status: 'fast-forward' };
  }
  if (p.conflicts === null) {
    throw new Error(`Can't merge into '${target}' without checking it out (needs git 2.38 or newer). Check it out in a worktree first.`);
  }
  if (p.conflicts.length) {
    throw new Error(`Merging would conflict in ${p.conflicts.length} file(s). Check '${target}' out in a worktree to resolve them.`);
  }
  const tree = (await git(root, ['merge-tree', '--write-tree', p.targetHash, p.sourceHash])).split('\n')[0].trim();
  const full = (await gitRaw(root, ['rev-parse', '--symbolic-full-name', source])).stdout.trim();
  const what = full.startsWith('refs/remotes/') ? `remote-tracking branch '${source}'`
    : full.startsWith('refs/heads/') ? `branch '${source}'` : `commit '${p.sourceHash.slice(0, 7)}'`;
  const commit = (await git(root, ['commit-tree', tree, '-p', p.targetHash, '-p', p.sourceHash, '-m', `Merge ${what} into ${target}`])).trim();
  await git(root, ['update-ref', '-m', `merge ${source}`, ref, commit, p.targetHash]);
  return { status: 'merged' };
}
