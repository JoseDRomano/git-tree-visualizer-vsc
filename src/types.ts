export interface Commit {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  time: number; // unix seconds
  subject: string;
}

export type RefKind = 'branch' | 'remote' | 'tag';

export interface RefInfo {
  name: string; // short name: main, origin/main, v1.0
  kind: RefKind;
  hash: string; // commit the ref points to (tags are peeled)
  upstream?: string;
  ahead?: number;
  behind?: number;
  gone?: boolean;
}

export interface Worktree {
  path: string;
  name: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
  isMain: boolean;
  isCurrent: boolean;
  dirty: number; // number of changed files, 0 when clean or unknown
}

export interface RepoSnapshot {
  root: string;
  name: string;
  commits: Commit[];
  refs: RefInfo[];
  worktrees: Worktree[];
  head?: string;
  headBranch?: string;
  defaultBranch?: string; // e.g. origin/main, from refs/remotes/origin/HEAD
  truncated: boolean;
}

export interface LoadOptions {
  maxCommits: number;
  remotes: boolean;
  tags: boolean;
}
