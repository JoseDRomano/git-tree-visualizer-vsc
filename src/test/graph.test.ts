import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getMergePreview, loadSnapshot, performMerge } from '../git';
import { buildGraph, GraphPayload } from '../graph';
import { buildBranchTree } from '../tree';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-tree-test-')));
const repo = path.join(base, 'repo');
fs.mkdirSync(repo);

let tick = 0;
function git(...args: string[]): string {
  tick++;
  const date = `2024-01-01T00:${String(Math.floor(tick / 60)).padStart(2, '0')}:${String(tick % 60).padStart(2, '0')}Z`;
  return execFileSync('git', args, {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_CONFIG_GLOBAL: '/dev/null' },
  }).toString().trim();
}
const commit = (msg: string) => {
  fs.writeFileSync(path.join(repo, 'f.txt'), msg + '\n');
  git('add', '.');
  git('commit', '-q', '-m', msg);
};

git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Test');
git('config', 'user.email', 'test@example.com');
commit('c1');
commit('c2');
git('tag', 'v1.0');
git('checkout', '-q', '-b', 'feature');
commit('f1');
commit('f2');
git('checkout', '-q', 'main');
fs.writeFileSync(path.join(repo, 'g.txt'), 'g\n');
git('add', '.');
git('commit', '-q', '-m', 'c3');
git('merge', '-q', '--no-ff', '-X', 'theirs', '-m', 'merge feature', 'feature');
// An undecorated bubble: a1 -> (a2, a3) on main and (s1, s2) on a deleted branch, merged back.
commit('a1');
git('checkout', '-q', '-b', 'side');
commit('s1');
commit('s2');
git('checkout', '-q', 'main');
fs.writeFileSync(path.join(repo, 'h.txt'), 'a2\n');
git('add', '.');
git('commit', '-q', '-m', 'a2');
fs.writeFileSync(path.join(repo, 'h.txt'), 'a3\n');
git('add', '.');
git('commit', '-q', '-m', 'a3');
git('merge', '-q', '--no-ff', '-X', 'theirs', '-m', 'merge side', 'side');
git('branch', '-D', 'side');
git('branch', 'hotfix', 'HEAD~1');
git('branch', 'release', 'main');          // same commit as the production tip
git('branch', 'feature-copy', 'feature'); // same commit as another branch
git('worktree', 'add', '-q', path.join(base, 'wt-hotfix'), 'hotfix');
git('worktree', 'add', '-q', '--detach', path.join(base, 'wt-old'), 'v1.0');
fs.writeFileSync(path.join(base, 'wt-hotfix', 'dirty.txt'), 'x\n');
fs.writeFileSync(path.join(repo, 'f.txt'), 'local edit\n');

function checkLayout(g: GraphPayload) {
  const rowOf = new Map(g.rows.map((r, i) => [r.hash, i]));
  assert.strictEqual(rowOf.size, g.rows.length, 'every row is unique');
  for (const e of g.edges) {
    if (e.to < 0) continue;
    assert.ok(e.to > e.from, 'edges point downwards');
    for (let r = e.from + 1; r < e.to; r++) {
      assert.notStrictEqual(g.rows[r].lane, e.viaLane, `edge ${e.from}->${e.to} runs through node at row ${r}`);
    }
  }
  for (const r of g.rows) for (const p of r.parents) assert.ok(rowOf.has(p), 'parents are loaded');
}

(async () => {
  const snap = await loadSnapshot(repo, { maxCommits: 1000, remotes: true, tags: true });

  assert.strictEqual(snap.worktrees.length, 3);
  assert.ok(snap.worktrees[0].isMain && snap.worktrees[0].isCurrent);
  const hot = snap.worktrees.find(w => w.branch === 'hotfix')!;
  assert.strictEqual(hot.dirty, 1);
  assert.ok(snap.worktrees.find(w => w.name === 'wt-old')!.detached);
  assert.strictEqual(snap.commits.length, 12);
  assert.ok(snap.refs.some(r => r.kind === 'tag' && r.name === 'v1.0'));

  const full = buildGraph(snap, 'full');
  checkLayout(full);
  const wips = full.rows.filter(r => r.wip);
  assert.strictEqual(wips.length, 2, 'two dirty worktrees -> two WIP rows');
  assert.strictEqual(snap.worktrees[wips[0].wip!.worktree].isCurrent, true, 'current worktree WIP first');
  assert.ok(full.edges.filter(e => e.dashed).length === 2);
  assert.ok(full.laneCount >= 2);

  const topo = buildGraph(snap, 'topology');
  checkLayout(topo);
  assert.ok(topo.rows.length < full.rows.length, 'topology collapses linear runs');
  const mergeSide = topo.rows.find(r => r.subject === 'merge side')!;
  assert.strictEqual(new Set(mergeSide.parents).size, 2, 'merge bubble survives compression');
  assert.ok(topo.edges.some(e => e.hidden > 0), 'collapsed counts recorded');

  const tree = buildBranchTree(snap)!;
  assert.strictEqual(tree.trunkName, 'main');
  assert.strictEqual(tree.limbs[0].kind, 'trunk');
  const limb = (name: string) => tree.limbs.find(l => l.names.includes(name))!;
  const feature = limb('feature');
  assert.strictEqual(feature.parent, 0);
  assert.strictEqual(feature.ahead, 2);
  assert.ok(feature.mergedAt !== undefined, 'feature is merged into main');
  const hotfix = limb('hotfix');
  assert.strictEqual(hotfix.ahead, 0, 'hotfix sits on main~1');
  assert.strictEqual(hotfix.behind, 1);
  assert.deepStrictEqual(hotfix.worktrees.map(i => snap.worktrees[i].name), ['wt-hotfix']);
  assert.ok(tree.events.some(e => e.tags.includes('v1.0')), 'tag on trunk becomes an event');
  assert.ok(tree.events.some(e => e.worktrees.length), 'detached worktree on trunk becomes an event');
  for (const b of snap.refs.filter(r => r.kind === 'branch')) {
    assert.ok(tree.limbs.some(l => l.names.length === 1 && l.names[0] === b.name), `${b.name} has its own node`);
  }
  const release = limb('release');
  assert.ok(release.parent === 0 && release.forkIdx === 0 && release.ahead === 0, 'release grows from the production tip');
  const copy = limb('feature-copy');
  assert.deepStrictEqual(limb('release').worktrees, [], 'worktree on main does not show on release');
  assert.ok(copy.ahead === 0 && copy.parent !== 0 && tree.limbs[copy.parent].names[0] === 'feature', 'feature-copy grows from feature');
  assert.strictEqual(buildBranchTree(snap, 'hotfix')!.trunkName, 'hotfix', 'production branch can be set');
  assert.strictEqual(buildBranchTree(snap, 'missing')!.trunkName, 'main', 'unknown production branch falls back to detection');
  for (const l of tree.limbs.slice(1)) {
    assert.ok(l.parent === 0 ? tree.events.some(e => e.idx === l.forkIdx) : l.parent < tree.limbs.length);
  }

  // ---- merging ----
  const scratch = path.join(base, 'wt-scratch');
  git('worktree', 'add', '-q', '--detach', scratch, 'main');
  const sgit = (...args: string[]) => execFileSync('git', args, { cwd: scratch, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  const branchWith = (name: string, file: string, content: string) => {
    sgit('checkout', '-q', '-B', name, 'main');
    fs.writeFileSync(path.join(scratch, file), content + '\n');
    sgit('add', '.');
    sgit('commit', '-q', '-m', name);
  };
  branchWith('side-a', 'a.txt', 'a');
  branchWith('side-b', 'b.txt', 'b');
  branchWith('c1', 'f.txt', 'one');
  branchWith('c2', 'f.txt', 'two');
  sgit('checkout', '-q', '--detach', 'main');
  git('branch', 'ff-base', 'main~1');
  const wts = (await loadSnapshot(repo, { maxCommits: 1000, remotes: true, tags: true })).worktrees;
  const revOf = (r: string) => git('rev-parse', r);

  const ff = await getMergePreview(repo, 'main', 'ff-base', wts);
  assert.ok(ff.fastForward && !ff.worktree, 'fast-forward preview');
  assert.strictEqual(ff.incoming, Number(git('rev-list', '--count', 'ff-base..main')));
  assert.deepStrictEqual(await performMerge(repo, 'main', 'ff-base', wts), { status: 'fast-forward' });
  assert.strictEqual(revOf('ff-base'), revOf('main'));

  const clean = await getMergePreview(repo, 'side-a', 'side-b', wts);
  assert.ok(!clean.fastForward && !clean.upToDate && clean.conflicts?.length === 0, 'clean merge preview');
  assert.strictEqual(clean.files, 1);
  assert.deepStrictEqual(await performMerge(repo, 'side-a', 'side-b', wts), { status: 'merged' });
  assert.strictEqual(git('rev-list', '--parents', '-n', '1', 'side-b').split(' ').length, 3, 'side-b got a merge commit');
  assert.strictEqual(git('show', 'side-b:a.txt'), 'a');
  assert.ok((await getMergePreview(repo, 'side-a', 'side-b', wts)).upToDate);

  const conflict = await getMergePreview(repo, 'c1', 'c2', wts);
  assert.deepStrictEqual(conflict.conflicts, ['f.txt']);
  const c2Before = revOf('c2');
  await assert.rejects(performMerge(repo, 'c1', 'c2', wts), /conflict/);
  assert.strictEqual(revOf('c2'), c2Before, 'conflicting merge leaves the branch alone');

  assert.ok((await getMergePreview(repo, 'side-a', 'hotfix', wts)).worktree, 'hotfix is checked out in a worktree');
  await assert.rejects(performMerge(repo, 'side-a', 'hotfix', wts), /uncommitted/);
  fs.rmSync(path.join(base, 'wt-hotfix', 'dirty.txt'));
  const inWt = await performMerge(repo, 'side-a', 'hotfix', wts);
  assert.strictEqual(inWt.status, 'fast-forward');
  assert.ok(fs.existsSync(path.join(base, 'wt-hotfix', 'a.txt')), 'merge ran inside the worktree');
  console.log('ok - merge preview and merging (fast-forward, merge commit, conflicts, worktree)');

  console.log(`ok - tree: ${tree.limbs.length} limbs on a ${tree.trunkLength}-commit trunk`);
  console.log(`ok - ${full.rows.length} rows / ${full.laneCount} lanes (full), ${topo.rows.length} rows (topology)`);
  fs.rmSync(base, { recursive: true, force: true });
})().catch(e => {
  console.error(e);
  console.error('repo kept at', repo);
  process.exit(1);
});
