// store.ts — The forge's in-memory state: repositories, git objects, refs,
// issues, pull requests, labels, and comments. Everything lives in Maps;
// nothing touches the disk or the network. A repository's git objects are
// real objects (SHA-1 addressed), so a clone verifies byte-for-byte.
import {
  buildCommit,
  buildTreesFromFiles,
  emptyTreeOid,
  flattenTree,
  hashObject,
  identity,
  isOid,
  mergeBase,
  parseCommit,
  threeWayMerge,
  type GitObject,
  type ObjectStore,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;

export const DEFAULT_BRANCH = 'main';

/** An error that maps directly onto an HTTP status + `{message}` body. */
export class StoreError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
  }
}

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Bumped by every mutation of this issue (state change, new comment).
   * The REST layer's serialized-issue cache validates against it, so a
   * cached GET response is never served after the issue changed.
   */
  version: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  prs: Map<number, PullRequest>;
  /** Issues and pull requests share one numbering sequence, like GitHub. */
  nextNumber: number;
  seq: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Bumped whenever refs change (createRef, receive-pack updates). The REST
   * layer's advertised-refs cache rebuilds when this moves.
   */
  refsVersion: number;
  /**
   * Bumped whenever labels change (createLabel). The serialized-issue cache
   * validates against it, because an issue's JSON embeds label colors.
   */
  labelsVersion: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/** The identity line stamped on commits the forge itself creates. */
function forgeIdentity(): string {
  return identity(VIEWER_NAME, VIEWER_EMAIL, nowUnix());
}

export class Store {
  private readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextObjectId = 1;
  private nextCommentId = 1;
  private seq = 0;

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** An ObjectStore view of one repository's objects. */
  objectStoreOf(repo: Repo): ObjectStore {
    return { get: (oid: string) => repo.objects.get(oid) };
  }

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  // ---------------------------------------------------------------- repos

  createRepo(owner: string, name: string, options: { private?: boolean; description?: string }): Repo {
    const key = this.key(owner, name);
    if (this.repos.has(key)) {
      throw new StoreError(422, `Repository ${owner}/${name} already exists`);
    }
    const at = nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      private: options.private ?? false,
      description: options.description ?? '',
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      prs: new Map(),
      nextNumber: 1,
      seq: this.nextSeq(),
      createdAt: at,
      updatedAt: at,
      refsVersion: 0,
      labelsVersion: 0,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** Find a repository by its numeric database id (GraphQL global ids). */
  getRepoById(id: number): Repo | null {
    for (const repo of this.repos.values()) {
      if (repo.id === id) return repo;
    }
    return null;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  // ---------------------------------------------------------------- refs

  /** The tip of `refs/heads/<branch>`, or undefined when the branch is unborn. */
  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  createRef(repo: Repo, ref: string, sha: string): void {
    if (!isOid(sha) || !repo.objects.has(sha)) {
      throw new StoreError(422, `Cannot create ${ref}: object ${sha} does not exist`);
    }
    if (repo.refs.has(ref)) throw new StoreError(422, `Reference ${ref} already exists`);
    repo.refs.set(ref, sha);
    repo.refsVersion += 1;
  }

  /**
   * Resolve a `ref` query value: a branch name, a full ref, or a commit id.
   * Returns the commit id, or null when nothing matches.
   */
  resolveRef(repo: Repo, ref: string | undefined): string | null {
    if (!ref) return this.branchTip(repo, repo.defaultBranch) ?? null;
    if (ref.startsWith('refs/')) {
      const sha = repo.refs.get(ref);
      return sha ?? null;
    }
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag) return tag;
    if (isOid(ref) && repo.objects.has(ref)) return ref;
    return null;
  }

  // ---------------------------------------------------------------- contents

  /**
   * Create or update a file through the contents API. Builds a real blob,
   * tree, and commit, and moves the branch. A branch that does not exist yet
   * is created from the default branch's tip (the MCP setup flow relies on
   * this leniency). `sha` pins the blob being replaced; a stale pin is a 409.
   */
  putContents(
    repo: Repo,
    options: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
  ): { commitSha: string; blobSha: string; created: boolean } {
    const branch = options.branch ?? repo.defaultBranch;
    let tip = this.branchTip(repo, branch);
    if (tip === undefined) {
      // Branch does not exist: start it from the default branch's tip.
      tip = this.branchTip(repo, repo.defaultBranch);
    }
    const baseTree = tip ? parseCommit(repo.objects.get(tip)!.data).tree : emptyTreeOid();
    const files = tip ? flattenTree(this.objectStoreOf(repo), baseTree) : new Map();
    const previous = files.get(options.path);
    if (options.sha !== undefined) {
      if (!previous) throw new StoreError(422, `File ${options.path} does not exist`);
      if (previous.oid !== options.sha) {
        throw new StoreError(409, `sha ${options.sha} does not match the current blob ${previous.oid}`);
      }
    }
    const blobSha = hashObject('blob', options.content);
    repo.objects.set(blobSha, { type: 'blob', data: options.content });
    files.set(options.path, { oid: blobSha, mode: '100644' });
    const { rootOid, trees } = buildTreesFromFiles(files);
    for (const [oid, obj] of trees) repo.objects.set(oid, obj);
    const who = forgeIdentity();
    const commitData = buildCommit({
      tree: rootOid,
      parents: tip ? [tip] : [],
      author: who,
      committer: who,
      // The message is stored verbatim: the REST checks compare it exactly
      // against the message the contents call sent.
      message: options.message,
    });
    const commitSha = hashObject('commit', commitData);
    repo.objects.set(commitSha, { type: 'commit', data: commitData });
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.refsVersion += 1;
    repo.updatedAt = nowIso();
    return { commitSha, blobSha, created: previous === undefined };
  }

  /** Delete a file through the contents API; the sha pin must match. */
  deleteContents(
    repo: Repo,
    options: { path: string; message: string; branch?: string; sha: string },
  ): { commitSha: string } {
    const branch = options.branch ?? repo.defaultBranch;
    const tip = this.branchTip(repo, branch);
    if (!tip) throw new StoreError(404, `Branch ${branch} does not exist`);
    const baseTree = parseCommit(repo.objects.get(tip)!.data).tree;
    const files = flattenTree(this.objectStoreOf(repo), baseTree);
    const previous = files.get(options.path);
    if (!previous) throw new StoreError(404, `File ${options.path} does not exist`);
    if (previous.oid !== options.sha) {
      throw new StoreError(409, `sha ${options.sha} does not match the current blob ${previous.oid}`);
    }
    files.delete(options.path);
    const { rootOid, trees } = buildTreesFromFiles(files);
    for (const [oid, obj] of trees) repo.objects.set(oid, obj);
    const who = forgeIdentity();
    const commitData = buildCommit({
      tree: rootOid,
      parents: [tip],
      author: who,
      committer: who,
      // Stored verbatim, like putContents (see above).
      message: options.message,
    });
    const commitSha = hashObject('commit', commitData);
    repo.objects.set(commitSha, { type: 'commit', data: commitData });
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.refsVersion += 1;
    repo.updatedAt = nowIso();
    return { commitSha };
  }

  // ---------------------------------------------------------------- labels

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { name, color };
    repo.labels.set(name, label);
    repo.labelsVersion += 1;
    return label;
  }

  listLabels(repo: Repo): Label[] {
    return [...repo.labels.values()];
  }

  // ---------------------------------------------------------------- issues

  createIssue(
    repo: Repo,
    options: { title: string; body?: string; labels?: string[] },
  ): Issue {
    const labels = options.labels ?? [];
    for (const name of labels) {
      if (!repo.labels.has(name)) throw new StoreError(422, `Label ${name} does not exist`);
    }
    const at = nowIso();
    const issue: Issue = {
      id: this.nextObjectId++,
      number: repo.nextNumber++,
      title: options.title,
      body: options.body ?? '',
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: this.nextSeq(),
      createdAt: at,
      updatedAt: at,
      version: 1,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  listIssues(
    repo: Repo,
    options: { state?: string; direction?: string },
  ): Issue[] {
    let out = [...repo.issues.values()];
    const state = options.state ?? 'open';
    if (state !== 'all') out = out.filter((issue) => issue.state === state);
    out.sort((a, b) => (options.direction === 'desc' ? b.seq - a.seq : a.seq - b.seq));
    return out;
  }

  setIssueState(repo: Repo, number: number, state: 'open' | 'closed'): Issue {
    const issue = repo.issues.get(number);
    if (!issue) throw new StoreError(404, `Issue #${number} does not exist`);
    issue.state = state;
    issue.updatedAt = nowIso();
    issue.version += 1;
    return issue;
  }

  addComment(repo: Repo, number: number, body: string): Comment {
    const issue = repo.issues.get(number);
    if (!issue) throw new StoreError(404, `Issue #${number} does not exist`);
    const at = nowIso();
    const comment: Comment = {
      id: this.nextCommentId++,
      body,
      seq: this.nextSeq(),
      createdAt: at,
      updatedAt: at,
    };
    issue.comments.push(comment);
    issue.updatedAt = at;
    issue.version += 1;
    return comment;
  }

  // ---------------------------------------------------------------- pull requests

  createPullRequest(
    repo: Repo,
    options: { title: string; body?: string; head: string; base: string },
  ): PullRequest {
    const headSha = this.branchTip(repo, options.head);
    if (!headSha) throw new StoreError(422, `Head branch ${options.head} does not exist`);
    const baseSha = this.branchTip(repo, options.base);
    if (!baseSha) throw new StoreError(422, `Base branch ${options.base} does not exist`);
    const at = nowIso();
    const pr: PullRequest = {
      id: this.nextObjectId++,
      number: repo.nextNumber++,
      title: options.title,
      body: options.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: options.head,
      baseRef: options.base,
      headSha,
      baseSha,
      seq: this.nextSeq(),
      createdAt: at,
      updatedAt: at,
    };
    repo.prs.set(pr.number, pr);
    return pr;
  }

  listPullRequests(repo: Repo, state: string): PullRequest[] {
    let out = [...repo.prs.values()];
    if (state === 'open') out = out.filter((pr) => pr.state === 'open');
    else if (state === 'closed') out = out.filter((pr) => pr.state === 'closed');
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /**
   * Squash-merge a pull request: one commit on the base branch whose tree is
   * the three-way merge of the merge-base, the base tip, and the head tip.
   * A conflict is a 405 — the pull request stays open.
   */
  mergePullRequest(repo: Repo, number: number): { sha: string; message: string } {
    const pr = repo.prs.get(number);
    if (!pr) throw new StoreError(404, `Pull request #${number} does not exist`);
    if (pr.state !== 'open') throw new StoreError(405, `Pull request #${number} is already ${pr.state}`);
    const store = this.objectStoreOf(repo);
    const baseTip = this.branchTip(repo, pr.baseRef);
    const headTip = this.branchTip(repo, pr.headRef);
    if (!baseTip || !headTip) throw new StoreError(422, 'A pull request branch no longer exists');
    const baseOfMerge = mergeBase(store, baseTip, headTip);
    const baseTree = baseOfMerge
      ? parseCommit(store.get(baseOfMerge)!.data).tree
      : emptyTreeOid();
    const oursTree = parseCommit(store.get(baseTip)!.data).tree;
    const theirsTree = parseCommit(store.get(headTip)!.data).tree;
    const { merged, conflicts } = threeWayMerge(
      flattenTree(store, baseTree),
      flattenTree(store, oursTree),
      flattenTree(store, theirsTree),
    );
    if (conflicts.length > 0) {
      throw new StoreError(405, `Merge conflict in ${conflicts.join(', ')}`);
    }
    const { rootOid, trees } = buildTreesFromFiles(merged);
    for (const [oid, obj] of trees) repo.objects.set(oid, obj);
    const who = forgeIdentity();
    const message = `${pr.title} (#${pr.number})\n`;
    const commitData = buildCommit({
      tree: rootOid,
      parents: [baseTip],
      author: who,
      committer: who,
      message,
    });
    const sha = hashObject('commit', commitData);
    repo.objects.set(sha, { type: 'commit', data: commitData });
    repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
    repo.refsVersion += 1;
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = nowIso();
    pr.mergeCommitSha = sha;
    pr.updatedAt = pr.mergedAt;
    repo.updatedAt = pr.mergedAt;
    return { sha, message: 'Pull request successfully merged' };
  }

  /** MERGEABLE / CONFLICTING / UNKNOWN for one pull request, computed live. */
  mergeableState(repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pr.state !== 'open') return 'UNKNOWN';
    const store = this.objectStoreOf(repo);
    const baseTip = this.branchTip(repo, pr.baseRef);
    const headTip = this.branchTip(repo, pr.headRef);
    if (!baseTip || !headTip) return 'UNKNOWN';
    const baseOfMerge = mergeBase(store, baseTip, headTip);
    const baseTree = baseOfMerge
      ? parseCommit(store.get(baseOfMerge)!.data).tree
      : emptyTreeOid();
    const { conflicts } = threeWayMerge(
      flattenTree(store, baseTree),
      flattenTree(store, parseCommit(store.get(baseTip)!.data).tree),
      flattenTree(store, parseCommit(store.get(headTip)!.data).tree),
    );
    return conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
  }
}

/** A no-op object store used before a repository exists. */
export const EMPTY_STORE: ObjectStore = { get: () => undefined };
