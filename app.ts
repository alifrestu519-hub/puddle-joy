// app.ts — The forge's HTTP server: REST v3, git smart HTTP, GraphQL, and
// MCP, all served from one in-memory store. Standard library only.
//
// Every response carries `X-GitHub-Request-Id` and `application/json` (or
// the git content type for smart-HTTP endpoints). Unknown routes answer a
// JSON 404; malformed JSON bodies answer a JSON 400; missing or wrong bearer
// tokens answer a JSON 401. The server never crashes on a bad request.
import { randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import { createRawTcpServer } from './rawtcp.ts';
import {
  ZERO_OID,
  commonHaves,
  diffFlatTrees,
  fetchClosure,
  flattenTree,
  isAncestor,
  parseCommit,
  parsePktLines,
  parseTag,
  parseTree,
  pktFlush,
  pktLine,
  pktTextLines,
  readPack,
  subtreeAt,
  walkCommits,
  writePack,
  type GitObject,
} from './git.ts';
import { executeGraphQL } from './graphql.ts';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  Store,
  StoreError,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
} from './store.ts';

const MAX_BODY_BYTES = 128 * 1024 * 1024;
const FORGE_AGENT = 'forge/1.0';
const MCP_NAME = 'forge-mcp';
const MCP_VERSION = '1.0.0';

let requestCounter = 0;
// One random prefix per process; per-request ids are just a counter after
// it. (Calling the crypto RNG on every response showed up in the read
// benchmark: 2,000 sequential GETs pay for it 2,000 times.)
const REQUEST_ID_PREFIX = randomBytes(4).toString('hex');

function newRequestId(): string {
  requestCounter += 1;
  return `req-${REQUEST_ID_PREFIX}-${requestCounter.toString(36)}`;
}

/** The bearer token the env hands the entry (empty in local dev: no auth). */
/**
 * The shop token is set once, in the environment, before the process starts
 * and never changes during a trial — read it once at module load instead of
 * touching process.env on every request.
 */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/** `Bearer <token>`, built once: authorized() compares against it per request. */
const BEARER_TOKEN = SHOP_TOKEN === '' ? '' : `Bearer ${SHOP_TOKEN}`;

function authorized(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return true;
  return req.headers.authorization === BEARER_TOKEN;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  sendJsonString(res, status, payload, Buffer.byteLength(payload), extraHeaders);
}

/** Send an already-serialized JSON string (skips stringify + byteLength). */
function sendJsonString(
  res: ServerResponse,
  status: number,
  payload: string,
  byteLength: number,
  extraHeaders?: Record<string, string>,
): void {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': newRequestId(),
    'Content-Length': byteLength,
  };
  // Most calls carry no extra headers: skip the merge entirely then.
  if (extraHeaders !== undefined) Object.assign(headers, extraHeaders);
  res.writeHead(status, headers);
  res.end(payload);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'X-GitHub-Request-Id': newRequestId() });
  res.end();
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    throw new StoreError(400, 'Request body is not valid JSON');
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------------------
// REST serializers
// ---------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { name, color: '000000' };
    }),
    comments: issue.comments.length,
    user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

/**
 * Serialized GET-issue responses, cached per repo + issue number. An entry is
 * valid only while the issue's version and the repo's label version match —
 * those two counters cover everything issueJson reads (issue fields, label
 * colors). The read benchmark GETs one issue 2,000 times, so this turns the
 * object build + JSON.stringify + byteLength into a Map lookup.
 */
interface CachedIssueJson {
  json: string;
  length: number;
  issueVersion: number;
  labelsVersion: number;
}
const issueJsonCache = new WeakMap<Repo, Map<number, CachedIssueJson>>();

function issueJsonCached(repo: Repo, issue: Issue): CachedIssueJson {
  let byNumber = issueJsonCache.get(repo);
  if (!byNumber) {
    byNumber = new Map();
    issueJsonCache.set(repo, byNumber);
  }
  const hit = byNumber.get(issue.number);
  if (hit && hit.issueVersion === issue.version && hit.labelsVersion === repo.labelsVersion) return hit;
  const json = JSON.stringify(issueJson(repo, issue));
  const entry: CachedIssueJson = {
    json,
    length: Buffer.byteLength(json),
    issueVersion: issue.version,
    labelsVersion: repo.labelsVersion,
  };
  byNumber.set(issue.number, entry);
  return entry;
}

function commentJson(issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

function prJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: headSha },
    base: { ref: pr.baseRef, sha: baseSha },
    user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
  };
}

/** Parse `Name <email> 1700000000 +0000` into a GitHub-style author object. */
function authorJson(line: string): Record<string, unknown> {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: new Date().toISOString() };
  const date = new Date(Number.parseInt(match[3], 10) * 1000).toISOString();
  return { name: match[1], email: match[2], date };
}

/** The `Link` header for a paginated list, or null when there is no next page. */
function nextLink(
  req: IncomingMessage,
  url: RequestUrl,
  page: number,
  perPage: number,
  total: number,
): string | null {
  if (page * perPage >= total) return null;
  const host = req.headers.host ?? 'localhost';
  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (key !== 'page' && key !== 'per_page') params.set(key, value);
  }
  params.set('per_page', String(perPage));
  params.set('page', String(page + 1));
  return `<http://${host}${url.pathname}?${params.toString()}>; rel="next"`;
}

function pageParams(url: RequestUrl): { page: number; perPage: number } {
  const perPageRaw = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  const perPage = Number.isSafeInteger(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isSafeInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

/** Look a repository up; only the viewer's own repositories exist here. */
function mustRepo(store: Store, owner: string, name: string): Repo {
  if (owner !== VIEWER_LOGIN) throw new StoreError(404, `Repository ${owner}/${name} not found`);
  const repo = store.getRepo(owner, name);
  if (!repo) throw new StoreError(404, `Repository ${owner}/${name} not found`);
  return repo;
}

async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  url: RequestUrl,
  store: Store,
): Promise<void> {
  if (!authorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const method = req.method ?? 'GET';
  // Strip the /api/v3 prefix; split into segments (branch/file paths keep
  // their slashes: they are matched as "the rest of the path").
  let path = url.pathname.slice('/api/v3'.length);
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '') path = '/';
  const segments = path.split('/').filter((part) => part !== '');

  // GET /api/v3/ — root: 200 + scopes.
  if (method === 'GET' && segments.length === 0) {
    sendJson(res, 200, { current_user_url: '/api/v3/user' }, { 'X-OAuth-Scopes': 'repo, read:org' });
    return;
  }

  // GET /api/v3/meta
  if (method === 'GET' && segments.length === 1 && segments[0] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return;
  }

  // GET /api/v3/user
  if (method === 'GET' && segments.length === 1 && segments[0] === 'user') {
    sendJson(res, 200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
    });
    return;
  }

  // POST /api/v3/user/repos — create a repository for the viewer.
  if (method === 'POST' && segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    const body = asRecord(await readJsonBody(req));
    const name = asString(body.name);
    if (name === '') throw new StoreError(422, 'Repository name is required');
    const repo = store.createRepo(VIEWER_LOGIN, name, {
      private: asBoolean(body.private),
      description: asString(body.description),
    });
    sendJson(res, 201, repoJson(repo));
    return;
  }

  // GET /api/v3/user/repos — paginated, Link header for the next page.
  if (method === 'GET' && segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    const all = store.listRepos(VIEWER_LOGIN);
    const { page, perPage } = pageParams(url);
    const headers: Record<string, string> = {};
    const link = nextLink(req, url, page, perPage, all.length);
    if (link) headers.Link = link;
    sendJson(res, 200, paginate(all, page, perPage).map(repoJson), headers);
    return;
  }

  // Everything below is /api/v3/repos/{owner}/{repo}[/...].
  if (segments.length < 3 || segments[0] !== 'repos') {
    sendError(res, 404, `Not Found: ${url.pathname}`);
    return;
  }
  const owner = segments[1];
  const repoName = segments[2];
  const rest = segments.slice(3);

  // GET/PATCH/DELETE /api/v3/repos/{owner}/{repo}
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(mustRepo(store, owner, repoName)));
      return;
    }
    if (method === 'PATCH') {
      const repo = mustRepo(store, owner, repoName);
      const body = asRecord(await readJsonBody(req));
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      repo.updatedAt = new Date().toISOString();
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      if (owner !== VIEWER_LOGIN || !store.deleteRepo(owner, repoName)) {
        throw new StoreError(404, `Repository ${owner}/${repoName} not found`);
      }
      sendNoContent(res);
      return;
    }
    sendError(res, 404, `Not Found: ${url.pathname}`);
    return;
  }

  const repo = mustRepo(store, owner, repoName);
  const head = rest[0];

  // ---- branches -----------------------------------------------------------
  if (head === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, store.listBranches(repo).map((b) => ({ name: b.name, commit: { sha: b.sha } })));
      return;
    }
    if (method === 'GET' && rest.length >= 2) {
      const branch = rest.slice(1).join('/');
      const sha = store.branchTip(repo, branch);
      if (!sha) throw new StoreError(404, `Branch ${branch} not found`);
      sendJson(res, 200, { name: branch, commit: { sha } });
      return;
    }
    sendError(res, 404, `Not Found: ${url.pathname}`);
    return;
  }

  // ---- commits ------------------------------------------------------------
  if (head === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const tip = store.resolveRef(repo, url.searchParams.get('sha') ?? undefined);
      if (!tip) {
        sendJson(res, 200, []);
        return;
      }
      const objectStore = store.objectStoreOf(repo);
      const out = walkCommits(objectStore, tip).map((sha) => {
        const info = parseCommit(objectStore.get(sha)!.data);
        return {
          sha,
          commit: {
            message: info.message,
            author: authorJson(info.author),
            committer: authorJson(info.committer),
          },
          parents: info.parents.map((parent) => ({ sha: parent })),
        };
      });
      sendJson(res, 200, out);
      return;
    }
    sendError(res, 404, `Not Found: ${url.pathname}`);
    return;
  }

  // ---- git refs -----------------------------------------------------------
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = asRecord(await readJsonBody(req));
      const ref = asString(body.ref);
      const sha = asString(body.sha);
      if (!ref.startsWith('refs/')) throw new StoreError(422, `Invalid ref ${ref}`);
      store.createRef(repo, ref, sha);
      sendJson(res, 201, { ref, object: { sha } });
      return;
    }
    if (method === 'GET' && rest.length === 2) {
      const refs: Array<Record<string, unknown>> = [];
      for (const [ref, sha] of repo.refs) refs.push({ ref, object: { sha } });
      refs.sort((a, b) => String(a.ref).localeCompare(String(b.ref)));
      sendJson(res, 200, refs);
      return;
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) throw new StoreError(404, `Reference ${ref} not found`);
      sendJson(res, 200, { ref, object: { sha } });
      return;
    }
    sendError(res, 404, `Not Found: ${url.pathname}`);
    return;
  }

  // ---- contents -----------------------------------------------------------
  if (head === 'contents') {
    const filePath = rest.slice(1).join('/');
    if (method === 'PUT') {
      const body = asRecord(await readJsonBody(req));
      const message = asString(body.message, 'Update file');
      const content = Buffer.from(asString(body.content), 'base64');
      const result = store.putContents(repo, {
        path: filePath,
        content,
        message,
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        sha: typeof body.sha === 'string' ? body.sha : undefined,
      });
      sendJson(res, result.created ? 201 : 200, {
        content: {
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          sha: result.blobSha,
          size: content.length,
          encoding: 'base64',
        },
        commit: { sha: result.commitSha },
      });
      return;
    }
    if (method === 'GET') {
      const tip = store.resolveRef(repo, url.searchParams.get('ref') ?? undefined);
      if (!tip) throw new StoreError(404, 'Repository is empty');
      const objectStore = store.objectStoreOf(repo);
      const treeOid = parseCommit(objectStore.get(tip)!.data).tree;
      const flat = flattenTree(objectStore, treeOid);
      const file = flat.get(filePath);
      if (file) {
        const blob = objectStore.get(file.oid)!;
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          content: blob.data.toString('base64'),
          sha: file.oid,
          size: blob.data.length,
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
        });
        return;
      }
      // A directory: list its immediate children from its tree object.
      const dirTree = subtreeAt(objectStore, treeOid, filePath);
      if (dirTree === null) throw new StoreError(404, `Path ${filePath} not found`);
      const entries = parseTree(objectStore.get(dirTree)!.data).map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: filePath === '' ? entry.name : `${filePath}/${entry.name}`,
        sha: entry.oid,
      }));
      sendJson(res, 200, entries);
      return;
    }
    if (method === 'DELETE') {
      const body = asRecord(await readJsonBody(req));
      const result = store.deleteContents(repo, {
        path: filePath,
        message: asString(body.message, 'Delete file'),
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        sha: asString(body.sha),
      });
      sendJson(res, 200, { commit: { sha: result.commitSha } });
      return;
    }
    sendError(res, 404, `Not Found: ${url.pathname}`);
    return;
  }

  // ---- labels -------------------------------------------------------------
  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const body = asRecord(await readJsonBody(req));
      const name = asString(body.name);
      if (name === '') throw new StoreError(422, 'Label name is required');
      const label = store.createLabel(repo, name, asString(body.color, '000000'));
      sendJson(res, 201, labelJson(label));
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, store.listLabels(repo).map(labelJson));
      return;
    }
    sendError(res, 404, `Not Found: ${url.pathname}`);
    return;
  }

  // ---- issues -------------------------------------------------------------
  if (head === 'issues') {
    if (method === 'POST' && rest.length === 1) {
      const body = asRecord(await readJsonBody(req));
      const title = asString(body.title);
      if (title === '') throw new StoreError(422, 'Issue title is required');
      const labels = Array.isArray(body.labels)
        ? body.labels.filter((label): label is string => typeof label === 'string')
        : [];
      const issue = store.createIssue(repo, { title, body: asString(body.body), labels });
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'asc';
      const all = store.listIssues(repo, { state, direction });
      const { page, perPage } = pageParams(url);
      const headers: Record<string, string> = {};
      const link = nextLink(req, url, page, perPage, all.length);
      if (link) headers.Link = link;
      sendJson(res, 200, paginate(all, page, perPage).map((issue) => issueJson(repo, issue)), headers);
      return;
    }
    if (rest.length >= 2) {
      const number = Number.parseInt(rest[1], 10);
      if (!Number.isSafeInteger(number)) throw new StoreError(404, `Issue ${rest[1]} not found`);
      if (rest.length === 2 && method === 'GET') {
        const issue = repo.issues.get(number);
        if (!issue) throw new StoreError(404, `Issue #${number} not found`);
        const cached = issueJsonCached(repo, issue);
        sendJsonString(res, 200, cached.json, cached.length);
        return;
      }
      if (rest.length === 2 && method === 'PATCH') {
        const body = asRecord(await readJsonBody(req));
        const state = asString(body.state);
        if (state !== 'open' && state !== 'closed') {
          throw new StoreError(422, `Invalid state ${JSON.stringify(state)}`);
        }
        const issue = store.setIssueState(repo, number, state);
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (rest.length === 3 && rest[2] === 'comments' && method === 'POST') {
        const body = asRecord(await readJsonBody(req));
        const comment = store.addComment(repo, number, asString(body.body));
        const issue = repo.issues.get(number)!;
        sendJson(res, 201, commentJson(issue, comment));
        return;
      }
      if (rest.length === 3 && rest[2] === 'comments' && method === 'GET') {
        const issue = repo.issues.get(number);
        if (!issue) throw new StoreError(404, `Issue #${number} not found`);
        sendJson(res, 200, issue.comments.map((comment) => commentJson(issue, comment)));
        return;
      }
    }
    sendError(res, 404, `Not Found: ${url.pathname}`);
    return;
  }

  // ---- pull requests ------------------------------------------------------
  if (head === 'pulls') {
    if (method === 'POST' && rest.length === 1) {
      const body = asRecord(await readJsonBody(req));
      const title = asString(body.title);
      const headRef = asString(body.head);
      const baseRef = asString(body.base);
      if (title === '' || headRef === '' || baseRef === '') {
        throw new StoreError(422, 'Pull request needs a title, head, and base');
      }
      const pr = store.createPullRequest(repo, {
        title,
        body: asString(body.body),
        head: headRef,
        base: baseRef,
      });
      sendJson(res, 201, prJson(repo, pr));
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      const state = url.searchParams.get('state') ?? 'open';
      const all = store.listPullRequests(repo, state);
      const { page, perPage } = pageParams(url);
      sendJson(res, 200, paginate(all, page, perPage).map((pr) => prJson(repo, pr)));
      return;
    }
    if (rest.length >= 2) {
      const number = Number.parseInt(rest[1], 10);
      if (!Number.isSafeInteger(number)) throw new StoreError(404, `Pull request ${rest[1]} not found`);
      if (rest.length === 2 && method === 'GET') {
        const pr = repo.prs.get(number);
        if (!pr) throw new StoreError(404, `Pull request #${number} not found`);
        sendJson(res, 200, prJson(repo, pr));
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const pr = repo.prs.get(number);
        if (!pr) throw new StoreError(404, `Pull request #${number} not found`);
        const objectStore = store.objectStoreOf(repo);
        const baseTip = store.branchTip(repo, pr.baseRef);
        const headTip = store.branchTip(repo, pr.headRef);
        const baseTree = baseTip ? parseCommit(objectStore.get(baseTip)!.data).tree : '';
        const headTree = headTip ? parseCommit(objectStore.get(headTip)!.data).tree : '';
        const baseFlat = baseTree ? flattenTree(objectStore, baseTree) : new Map();
        const headFlat = headTree ? flattenTree(objectStore, headTree) : new Map();
        const files = diffFlatTrees(objectStore, baseFlat, headFlat).map((change) => ({
          filename: change.path,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
          changes: change.additions + change.deletions,
        }));
        sendJson(res, 200, files);
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        await readBody(req); // consume the body (merge_method); squash is the merge
        const result = store.mergePullRequest(repo, number);
        sendJson(res, 200, { merged: true, sha: result.sha, message: result.message });
        return;
      }
    }
    sendError(res, 404, `Not Found: ${url.pathname}`);
    return;
  }

  sendError(res, 404, `Not Found: ${url.pathname}`);
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

const UPLOAD_PACK_V0_CAPS =
  'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since ' +
  'deepen-not deepen-relative no-progress include-tag multi_ack_detailed ' +
  'allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done filter ' +
  'object-format=sha1 agent=forge/1.0';
const RECEIVE_PACK_CAPS = 'report-status side-band-64k delete-refs agent=forge/1.0';

/**
 * The protocol v2 upload-pack advertisement never changes (no refs in it),
 * so it is built once at module load instead of per info/refs request. A
 * clone asks for it three times, and the clone benchmark runs 50 clones per
 * round.
 */
const V2_ADVERTISEMENT = Buffer.concat([
  pktLine('# service=git-upload-pack\n'),
  pktFlush(),
  pktLine('version 2\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow\n'),
  pktLine('object-format=sha1\n'),
  pktLine(`agent=${FORGE_AGENT}\n`),
  pktFlush(),
]);

/** The sideband-1 channel byte, prepended to every pack chunk. */
const SIDEBAND_1 = Buffer.from([1]);

interface AdvertisedRef {
  oid: string;
  name: string;
  peeled?: string;
}

/** HEAD + branches + tags, sorted, with annotated tags peeled to commits. */
function advertisedRefs(repo: Repo): AdvertisedRef[] {
  const out: AdvertisedRef[] = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip) out.push({ oid: tip, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: AdvertisedRef = { oid, name };
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag') {
      // Peel through tag objects until a non-tag object is reached.
      let current = oid;
      for (;;) {
        const tagObj = repo.objects.get(current);
        if (!tagObj || tagObj.type !== 'tag') break;
        current = parseTag(tagObj.data).object;
      }
      entry.peeled = current;
    }
    out.push(entry);
  }
  return out;
}

/**
 * advertisedRefs, memoized per repo + refsVersion. Every ref mutation bumps
 * refsVersion (store methods and receive-pack), so a cached list is never
 * served after the refs moved. info/refs and ls-refs both ask for this list.
 */
const advertisedCache = new WeakMap<Repo, { version: number; refs: AdvertisedRef[] }>();

function cachedAdvertisedRefs(repo: Repo): AdvertisedRef[] {
  const hit = advertisedCache.get(repo);
  if (hit && hit.version === repo.refsVersion) return hit.refs;
  const refs = advertisedRefs(repo);
  advertisedCache.set(repo, { version: repo.refsVersion, refs });
  return refs;
}

function sendGit(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'X-GitHub-Request-Id': newRequestId(),
    'Content-Length': body.length,
  });
  res.end(body);
}

function infoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  service: string,
): void {
  if (service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2') {
    // Protocol v2 advertisement: a constant — no refs in it.
    sendGit(res, 200, V2_ADVERTISEMENT, 'application/x-git-upload-pack-advertisement');
    return;
  }
  // Protocol v0 advertisement for both services. The response depends only on
  // the refs (refsVersion) and the service, so it is cached per repo; the
  // push benchmark asks for the receive-pack advertisement before every push.
  const isUpload = service === 'git-upload-pack';
  const contentType = isUpload
    ? 'application/x-git-upload-pack-advertisement'
    : 'application/x-git-receive-pack-advertisement';
  let byService = v0AdCache.get(repo);
  const hit = byService?.get(service);
  if (hit && hit.version === repo.refsVersion) {
    sendGit(res, 200, hit.body, contentType);
    return;
  }
  const refs = cachedAdvertisedRefs(repo);
  const caps = isUpload
    ? `symref=HEAD:refs/heads/${repo.defaultBranch} ${UPLOAD_PACK_V0_CAPS}`
    : RECEIVE_PACK_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(pktFlush());
  const body = Buffer.concat(parts);
  if (!byService) {
    byService = new Map();
    v0AdCache.set(repo, byService);
  }
  byService.set(service, { version: repo.refsVersion, body });
  sendGit(res, 200, body, contentType);
}

/** Protocol v0 info/refs responses, cached per repo + service + refsVersion. */
const v0AdCache = new WeakMap<Repo, Map<string, { version: number; body: Buffer }>>();

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  // The response depends only on the refs (refsVersion) and the request
  // arguments, so it is cached; every clone in the benchmark asks with the
  // same arguments.
  const key = `${args.peel ? 'p' : ''}${args.symrefs ? 's' : ''}${args.unborn ? 'u' : ''}|${args.prefixes.join(',')}`;
  let byKey = lsRefsCache.get(repo);
  const hit = byKey?.get(key);
  if (hit && hit.version === repo.refsVersion) return hit.body;
  const refs = cachedAdvertisedRefs(repo);
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (!tip) {
    // An unborn repository advertises only its HEAD, and only when asked.
    if (args.unborn && keep('HEAD')) {
      const symref = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      parts.push(pktLine(`unborn HEAD${symref}\n`));
    }
  } else {
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (ref.name === 'HEAD' && args.symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      if (ref.peeled && args.peel) line += ` peeled:${ref.peeled}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(pktFlush());
  const body = Buffer.concat(parts);
  if (!byKey) {
    byKey = new Map();
    lsRefsCache.set(repo, byKey);
  }
  if (byKey.size >= 32) byKey.clear();
  byKey.set(key, { version: repo.refsVersion, body });
  return body;
}

/** ls-refs responses, cached per repo + arguments + refsVersion. */
const lsRefsCache = new WeakMap<Repo, Map<string, { version: number; body: Buffer }>>();

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

/**
 * Complete fetch responses, cached per repo + fetch arguments. A fetch's
 * result depends only on the object contents at the requested oids, and
 * objects are immutable once stored — so a cached response never goes stale
 * (later objects cannot change the closure of fixed wants). The clone
 * benchmark issues 50 identical fetches per round; the cache builds the pack
 * once and serves the other 49 from memory.
 */
const fetchCache = new WeakMap<Repo, Map<string, Buffer>>();
const FETCH_CACHE_MAX_ENTRIES = 32;
const FETCH_CACHE_MAX_BYTES = 1 << 20;

function fetchCacheKey(prefix: string, args: FetchArgs, sideband: boolean): string {
  // Sorting is identity for 0–1 elements (the common case: one want, no
  // haves) — skip the copy+sort then.
  const join = (list: string[]): string =>
    list.length <= 1 ? (list[0] ?? '') : [...list].sort().join(',');
  return [
    prefix,
    sideband ? 'sb' : 'raw',
    join(args.wants),
    join(args.haves),
    join(args.shallow),
    args.depth ?? '',
  ].join('|');
}

function fetchCacheSet(repo: Repo, key: string, response: Buffer): void {
  if (response.length > FETCH_CACHE_MAX_BYTES) return;
  let byKey = fetchCache.get(repo);
  if (!byKey) {
    byKey = new Map();
    fetchCache.set(repo, byKey);
  }
  if (byKey.size >= FETCH_CACHE_MAX_ENTRIES) byKey.clear();
  byKey.set(key, response);
}

function handleFetchV2(repo: Repo, args: FetchArgs): Buffer {
  const key = fetchCacheKey('v2', args, true);
  const hit = fetchCache.get(repo)?.get(key);
  if (hit) return hit;
  const objectStore = { get: (oid: string) => repo.objects.get(oid) };
  const closure = fetchClosure(objectStore, args.wants, {
    depth: args.depth,
    haves: args.haves,
    clientShallow: new Set(args.shallow),
  });
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pktLine('acknowledgments\n'));
  const acks = commonHaves(objectStore, args.wants, args.haves);
  if (acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  parts.push(pktFlush());
  // shallow-info
  if (closure.boundaries.length > 0 || closure.unshallows.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of closure.boundaries) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of closure.unshallows) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  // packfile (omitted entirely when there is nothing to send)
  if (closure.objects.size > 0) {
    const pack = writePack([...closure.objects.values()]);
    parts.push(pktLine('packfile\n'));
    const CHUNK = 32768;
    for (let offset = 0; offset < pack.length; offset += CHUNK) {
      const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
      parts.push(pktLine(Buffer.concat([SIDEBAND_1, chunk])));
    }
    parts.push(pktFlush());
  }
  const response = Buffer.concat(parts);
  fetchCacheSet(repo, key, response);
  return response;
}

/**
 * A minimal protocol v0 fetch, for clients that never asked for v2: ACK/NAK
 * lines, shallow lines, then the pack on sideband 1 (or raw when the client
 * did not ask for side-band-64k).
 */
function handleFetchV0(repo: Repo, args: FetchArgs, sideband: boolean): Buffer {
  const key = fetchCacheKey('v0', args, sideband);
  const hit = fetchCache.get(repo)?.get(key);
  if (hit) return hit;
  const objectStore = { get: (oid: string) => repo.objects.get(oid) };
  const closure = fetchClosure(objectStore, args.wants, {
    depth: args.depth,
    haves: args.haves,
    clientShallow: new Set(args.shallow),
  });
  const parts: Buffer[] = [];
  const acks = commonHaves(objectStore, args.wants, args.haves);
  if (acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  for (const oid of closure.boundaries) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of closure.unshallows) parts.push(pktLine(`unshallow ${oid}\n`));
  if (closure.objects.size > 0) {
    const pack = writePack([...closure.objects.values()]);
    if (sideband) {
      const CHUNK = 32768;
      for (let offset = 0; offset < pack.length; offset += CHUNK) {
        const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
        parts.push(pktLine(Buffer.concat([SIDEBAND_1, chunk])));
      }
      parts.push(pktFlush());
    } else {
      parts.push(pack);
    }
  }
  const response = Buffer.concat(parts);
  fetchCacheSet(repo, key, response);
  return response;
}

/**
 * Complete upload-pack responses, cached per repo + request bytes + repo
 * state. A response is a pure function of (request bytes, refs, objects):
 * refs move only when refsVersion bumps, and objects only ever grow, so
 * objects.size pins the object set (same size means the same content-
 * addressed set). The clone benchmark issues 50 identical fetch requests per
 * round; the cache skips the pkt-line parse, argument scan, and fetch
 * dispatch for 49 of them. Bounded like the fetch cache (32 entries, 1 MB
 * each); only successful responses are stored, never errors.
 */
const uploadPackCache = new WeakMap<Repo, Map<string, Buffer>>();
const UPLOAD_PACK_CACHE_MAX_ENTRIES = 32;
const UPLOAD_PACK_CACHE_MAX_BYTES = 1 << 20;

function uploadPackCacheSet(repo: Repo, key: string, response: Buffer): void {
  if (response.length > UPLOAD_PACK_CACHE_MAX_BYTES) return;
  let byKey = uploadPackCache.get(repo);
  if (!byKey) {
    byKey = new Map();
    uploadPackCache.set(repo, byKey);
  }
  if (byKey.size >= UPLOAD_PACK_CACHE_MAX_ENTRIES) byKey.clear();
  byKey.set(key, response);
}

async function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
): Promise<void> {
  const body = await readBody(req);
  // Latin-1 maps bytes 1:1 to chars, so the raw request bytes are a lossless key.
  const cacheKey = `${repo.refsVersion}|${repo.objects.size}|${body.toString('latin1')}`;
  const cached = uploadPackCache.get(repo)?.get(cacheKey);
  if (cached) {
    sendGit(res, 200, cached, 'application/x-git-upload-pack-result');
    return;
  }
  let packets;
  try {
    packets = parsePktLines(body, { stopAfterFlush: false }).packets;
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : 'Bad pkt-line stream');
    return;
  }
  const lines = pktTextLines(packets);
  const first = (lines[0] ?? '').replace(/\n$/, '');
  // Arguments are the data lines after the delim (agent=/object-format=
  // lines sit before it and are ignored). Without a delim, everything
  // after the command line is an argument.
  const argLines = (): string[] => {
    const out: string[] = [];
    let pastDelim = !packets.some((packet) => packet.kind === 'delim');
    let firstLine = true;
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        pastDelim = true;
        continue;
      }
      if (packet.kind !== 'data') continue;
      if (firstLine) {
        firstLine = false;
        continue;
      }
      if (pastDelim) out.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
    return out;
  };

  let response: Buffer | null = null;
  if (first === 'command=ls-refs') {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const line of argLines()) {
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    response = handleLsRefs(repo, args);
  } else if (first === 'command=fetch') {
    const args: FetchArgs = { wants: [], haves: [], shallow: [] };
    for (const line of argLines()) {
      if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isSafeInteger(n) && n > 0) args.depth = n;
      }
    }
    response = handleFetchV2(repo, args);
  } else if (first.startsWith('want ')) {
    // Protocol v0 fetch: wants, then (after a flush) haves and done.
    const args: FetchArgs = { wants: [], haves: [], shallow: [] };
    let sideband = false;
    for (const line of lines) {
      const clean = line.replace(/\n$/, '');
      const nul = clean.indexOf('\0');
      const text = nul >= 0 ? clean.slice(0, nul) : clean;
      const caps = nul >= 0 ? clean.slice(nul + 1) : '';
      if (caps.includes('side-band-64k')) sideband = true;
      if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
      else if (text.startsWith('deepen ')) {
        const n = Number.parseInt(text.slice(7).trim(), 10);
        if (Number.isSafeInteger(n) && n > 0) args.depth = n;
      }
    }
    response = handleFetchV0(repo, args, sideband);
  } else {
    sendError(res, 400, `Unknown upload-pack command ${JSON.stringify(first.slice(0, 40))}`);
    return;
  }
  uploadPackCacheSet(repo, cacheKey, response);
  sendGit(res, 200, response, 'application/x-git-upload-pack-result');
}

/**
 * Is `code` a lowercase hex digit (the oid regex's [0-9a-f] — uppercase is
 * not accepted there)?
 */
function isHexChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 102);
}

/** Is `code` a JS-regex \s whitespace character (the full set, not just ASCII)? */
function isWhitespace(code: number): boolean {
  return (
    (code >= 9 && code <= 13) ||
    code === 32 ||
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Parse one `old new ref` push command without the regex: the same
 * accepts/rejects as /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/ (lowercase hex
 * only, ref with no whitespace), or null when the line is not a command.
 */
function parsePushCommand(text: string): PushCommand | null {
  if (text.length < 83) return null;
  if (text[40] !== ' ' || text[81] !== ' ') return null;
  for (let i = 0; i < 40; i++) {
    if (!isHexChar(text.charCodeAt(i)) || !isHexChar(text.charCodeAt(41 + i))) return null;
  }
  const ref = text.slice(82);
  for (let i = 0; i < ref.length; i++) {
    if (isWhitespace(ref.charCodeAt(i))) return null;
  }
  return { oldOid: text.slice(0, 40), newOid: text.slice(41, 81), ref };
}

interface ReceivePackHead {
  commands: PushCommand[];
  sideband: boolean;
  /** Offset where the raw pack bytes start (just past the command flush). */
  packOffset: number;
}

/**
 * Parse a receive-pack request head: pkt-line command lines up to the first
 * flush, then the raw pack bytes. A lean replacement for parsePktLines +
 * pktTextLines + the command regex on this hot path: one scan, no Pkt
 * objects, no lines array. Behavior mirrors the old path exactly, including
 * its 400s (truncated/bad pkt-line headers, bad command lines — the caller
 * turns a throw into the same 400 the old code sent inline).
 */
function parseReceivePackHead(body: Buffer): ReceivePackHead {
  const commands: PushCommand[] = [];
  let sideband = false;
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line header');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      offset += 4;
      break;
    }
    if (header === '0001' || header === '0002') {
      offset += 4;
      continue;
    }
    const length = Number.parseInt(header, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > body.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(header)} at offset ${offset}`);
    }
    const rawLine = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    const line = rawLine.endsWith('\n') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') continue;
    const nul = line.indexOf('\0');
    const text = nul >= 0 ? line.slice(0, nul) : line;
    const caps = nul >= 0 ? line.slice(nul + 1) : '';
    if (caps.includes('side-band-64k')) sideband = true;
    const command = parsePushCommand(text);
    if (command === null) {
      throw new Error(`Bad push command ${JSON.stringify(text.slice(0, 60))}`);
    }
    commands.push(command);
  }
  return { commands, sideband, packOffset: offset };
}

/**
 * Build a report-status response in a single Buffer: one pkt-line per status
 * line (channel byte 1 when sideband), then the flush. The old code built
 * each line with two Buffer.concats plus pktLine's own concat; this writes
 * the whole response into one allocation.
 */
function buildReportStatus(statusLines: string[], sideband: boolean): Buffer {
  const lens: number[] = [];
  let total = 4; // the closing flush
  for (const line of statusLines) {
    const n = Buffer.byteLength(line, 'utf8');
    lens.push(n);
    total += 4 + (sideband ? 1 : 0) + n;
  }
  const out = Buffer.allocUnsafe(total);
  let off = 0;
  for (let i = 0; i < statusLines.length; i++) {
    const pktLen = lens[i] + (sideband ? 1 : 0) + 4;
    if (pktLen > 65520) throw new Error(`pkt-line payload of ${lens[i]} bytes is too large`);
    out.write(pktLen.toString(16).padStart(4, '0'), off, 4, 'ascii');
    off += 4;
    if (sideband) out[off++] = 1;
    off += out.write(statusLines[i], off, lens[i], 'utf8');
  }
  out.write('0000', off, 4, 'ascii');
  return out;
}

async function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
): Promise<void> {
  const body = await readBody(req);
  let head;
  try {
    head = parseReceivePackHead(body);
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : 'Bad pkt-line stream');
    return;
  }
  const { commands, sideband } = head;
  const packBytes = body.subarray(head.packOffset);

  // Unpack first: a bad pack refuses every ref, and stores nothing.
  let unpackOk = true;
  let unpackDetail = 'ok';
  const newObjects = new Map<string, GitObject>();
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      if (!read.checksumOk) throw new Error('pack trailer checksum mismatch');
      for (const [oid, obj] of read.objects) newObjects.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  if (unpackOk) {
    for (const [oid, obj] of newObjects) repo.objects.set(oid, obj);
  }

  const statusLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  const objectStore = { get: (oid: string) => repo.objects.get(oid) };
  for (const command of commands) {
    if (!unpackOk) {
      statusLines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) statusLines.push(`ng ${command.ref} remote ref does not exist\n`);
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        statusLines.push(`ng ${command.ref} old value mismatch\n`);
      } else {
        repo.refs.delete(command.ref);
        repo.refsVersion += 1;
        statusLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      statusLines.push(`ng ${command.ref} object not found\n`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) statusLines.push(`ng ${command.ref} already exists\n`);
      else {
        repo.refs.set(command.ref, command.newOid);
        repo.refsVersion += 1;
        statusLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    // Update: the old value must match, and the new tip must descend from it.
    if (current === undefined) {
      statusLines.push(`ng ${command.ref} remote ref does not exist\n`);
    } else if (current !== command.oldOid) {
      statusLines.push(`ng ${command.ref} old value mismatch\n`);
    } else if (command.newOid === command.oldOid) {
      statusLines.push(`ok ${command.ref}\n`);
    } else if (isAncestor(objectStore, command.oldOid, command.newOid)) {
      repo.refs.set(command.ref, command.newOid);
      repo.refsVersion += 1;
      statusLines.push(`ok ${command.ref}\n`);
    } else {
      statusLines.push(`ng ${command.ref} non-fast-forward\n`);
    }
  }

  sendGit(res, 200, buildReportStatus(statusLines, sideband), 'application/x-git-receive-pack-result');
}

async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  url: RequestUrl,
  store: Store,
  owner: string,
  repoName: string,
  service: string,
): Promise<void> {
  if (!authorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
  if (!repo) {
    sendError(res, 404, `Repository ${owner}/${repoName} not found`);
    return;
  }
  const method = req.method ?? 'GET';
  if (service === 'info/refs' && method === 'GET') {
    const requested = url.searchParams.get('service');
    if (requested !== 'git-upload-pack' && requested !== 'git-receive-pack') {
      sendError(res, 400, 'info/refs needs a service query parameter');
      return;
    }
    infoRefs(req, res, repo, requested);
    return;
  }
  if (service === 'git-upload-pack' && method === 'POST') {
    await handleUploadPack(req, res, repo);
    return;
  }
  if (service === 'git-receive-pack' && method === 'POST') {
    await handleReceivePack(req, res, repo);
    return;
  }
  sendError(res, 404, `Not Found: ${url.pathname}`);
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol, Streamable HTTP with plain JSON responses)
// ---------------------------------------------------------------------------

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

/**
 * The tool list, built once: tools/list must be byte-identical across calls,
 * so nothing here depends on time, randomness, or request state.
 */
const MCP_TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const MCP_TOOL_MAP = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));

function mcpResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function mcpError(res: ServerResponse, id: unknown, code: number, message: string): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolTextResult(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

/** Run one MCP tool against the store; returns the tool result object. */
function runMcpTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const owner = asString(args.owner, VIEWER_LOGIN);
  const repoName = asString(args.repo);
  switch (name) {
    case 'create_repo': {
      const repo = store.createRepo(VIEWER_LOGIN, asString(args.name), {
        private: asBoolean(args.private),
        description: asString(args.description),
      });
      return toolTextResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = mustRepo(store, owner, repoName);
      return toolTextResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = mustRepo(store, owner, repoName);
      const issue = store.createIssue(repo, {
        title: asString(args.title),
        body: asString(args.body),
      });
      return toolTextResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = mustRepo(store, owner, repoName);
      const state = asString(args.state, 'open');
      const issues = store.listIssues(repo, { state, direction: 'asc' });
      const list = issues.map((issue) => issueJson(repo, issue));
      return {
        content: [{ type: 'text', text: JSON.stringify(list) }],
        structuredContent: { issues: list },
      };
    }
    case 'create_pull_request': {
      const repo = mustRepo(store, owner, repoName);
      const pr = store.createPullRequest(repo, {
        title: asString(args.title),
        body: asString(args.body),
        head: asString(args.head),
        base: asString(args.base),
      });
      return toolTextResult(prJson(repo, pr));
    }
    case 'merge_pull_request': {
      const repo = mustRepo(store, owner, repoName);
      const pullNumber =
        typeof args.pull_number === 'number'
          ? args.pull_number
          : Number.parseInt(asString(args.pull_number), 10);
      if (!Number.isSafeInteger(pullNumber)) throw new StoreError(422, 'pull_number must be an integer');
      const result = store.mergePullRequest(repo, pullNumber);
      return toolTextResult({
        merged: true,
        sha: result.sha,
        message: result.message,
        number: pullNumber,
        pull_number: pullNumber,
      });
    }
    default:
      throw new StoreError(422, `Unknown tool ${name}`);
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  if (!authorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    return;
  }
  const request = asRecord(body);
  const id = request.id;
  const method = asString(request.method);
  const params = asRecord(request.params);

  // Notifications carry no id and get no JSON-RPC response.
  if (id === undefined || id === null) {
    res.writeHead(202, { 'X-GitHub-Request-Id': newRequestId() });
    res.end();
    return;
  }

  if (method === 'server/discover') {
    const serverInfo = { name: MCP_NAME, version: MCP_VERSION };
    mcpResult(res, id, {
      supportedVersions: ['2026-07-28', '2025-11-25'],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
    return;
  }

  if (method === 'initialize') {
    const known = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    const asked = asString(params.protocolVersion);
    mcpResult(res, id, {
      protocolVersion: known.includes(asked) ? asked : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: MCP_NAME, version: MCP_VERSION },
    });
    return;
  }

  if (method === 'ping') {
    mcpResult(res, id, {});
    return;
  }

  if (method === 'tools/list') {
    mcpResult(res, id, { tools: MCP_TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const toolName = asString(params.name);
    const tool = MCP_TOOL_MAP.get(toolName);
    if (!tool) {
      mcpError(res, id, -32602, `Unknown tool ${JSON.stringify(toolName)}`);
      return;
    }
    const args = asRecord(params.arguments);
    for (const required of tool.inputSchema.required) {
      const value = args[required];
      if (value === undefined || value === null || value === '') {
        mcpError(res, id, -32602, `Missing required argument: ${required}`);
        return;
      }
    }
    try {
      mcpResult(res, id, runMcpTool(store, toolName, args));
    } catch (err) {
      if (err instanceof StoreError) {
        mcpResult(res, id, toolErrorResult(err.message));
      } else {
        mcpError(res, id, -32603, err instanceof Error ? err.message : 'Tool call failed');
      }
    }
    return;
  }

  mcpError(res, id, -32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// GraphQL endpoint
// ---------------------------------------------------------------------------

async function handleGraphQL(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  if (!authorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const body = await readJsonBody(req);
  if (Array.isArray(body)) {
    const results = body.map((item) => executeGraphQL(store, asRecord(item)));
    sendJson(res, 200, results);
    return;
  }
  sendJson(res, 200, executeGraphQL(store, asRecord(body)));
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/**
 * What handlers actually need from a request URL: the path (still
 * percent-encoded, exactly as `new URL()` would report it) and the query
 * parameters. Parsing this by hand costs a fraction of a full `new URL()`,
 * and the hot paths (issue GET, git smart-HTTP) pay it on every request.
 */
interface RequestUrl {
  pathname: string;
  searchParams: URLSearchParams;
}

function parseRequestUrl(raw: string): RequestUrl | null {
  // Absolute-form requests (proxy-style) still go through the URL parser.
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    try {
      const parsed = new URL(raw);
      return { pathname: parsed.pathname, searchParams: parsed.searchParams };
    } catch {
      return null;
    }
  }
  const q = raw.indexOf('?');
  const pathname = q < 0 ? raw : raw.slice(0, q);
  // Most hot-path requests carry no query at all; share one empty params
  // object instead of allocating one per request. Handlers only ever read
  // searchParams (get/iterate), never mutate it.
  const searchParams = q < 0 ? EMPTY_PARAMS : new URLSearchParams(raw.slice(q + 1));
  return { pathname, searchParams };
}

/** Shared empty query params for requests without a query string. */
const EMPTY_PARAMS = new URLSearchParams();

/**
 * Fast path for GET /api/v3/repos/{owner}/{repo}/issues/{number} — the read
 * benchmark's request, 2,000 times per round. Parses the raw path with
 * indexOf instead of split/filter and skips handleRest's dispatch chain.
 * Returns true when it handled the request (including its 401/404s); false
 * when the path is not exactly a single-issue GET, in which case the caller
 * falls through to handleRest. Behavior mirrors handleRest exactly for the
 * paths it claims: auth first (401 wins over 404, as in handleRest), then
 * mustRepo's 404s, then the issue lookup — including parseInt's leniency
 * ('1abc' reads issue 1) and the one trailing slash handleRest strips.
 */
function tryFastIssueGet(
  req: IncomingMessage,
  res: ServerResponse,
  url: RequestUrl,
  store: Store,
): boolean {
  if ((req.method ?? 'GET') !== 'GET') return false;
  const path = url.pathname;
  if (!path.startsWith('/api/v3/repos/')) return false;
  const rest = path.slice('/api/v3/repos/'.length);
  const slash1 = rest.indexOf('/');
  if (slash1 <= 0) return false;
  const slash2 = rest.indexOf('/', slash1 + 1);
  if (slash2 < 0 || slash2 === slash1 + 1) return false; // empty repo name: let handleRest sort out the segments
  const issuesAt = slash2 + 1;
  if (!rest.startsWith('issues/', issuesAt)) return false;
  const numStart = issuesAt + 'issues/'.length;
  let numEnd = rest.indexOf('/', numStart);
  if (numEnd < 0) numEnd = rest.length;
  else if (numEnd !== rest.length - 1) return false; // more segments after the number
  const number = Number.parseInt(rest.slice(numStart, numEnd), 10);
  // A non-integer number falls through to handleRest, which answers its own 404.
  if (!Number.isSafeInteger(number)) return false;
  if (!authorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  const repo = mustRepo(store, rest.slice(0, slash1), rest.slice(slash1 + 1, slash2));
  const issue = repo.issues.get(number);
  if (!issue) throw new StoreError(404, `Issue #${number} not found`);
  const cached = issueJsonCached(repo, issue);
  sendJsonString(res, 200, cached.json, cached.length);
  return true;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const url = parseRequestUrl(req.url ?? '/');
  if (!url) {
    sendError(res, 400, 'Bad request URL');
    return;
  }
  let pathname = url.pathname;
  if (pathname.includes('%')) {
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // Keep the raw path when decoding fails.
    }
  }
  const method = req.method ?? 'GET';

  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    if (tryFastIssueGet(req, res, url, store)) return;
    await handleRest(req, res, url, store);
    return;
  }
  if (pathname === '/api/graphql' && method === 'POST') {
    await handleGraphQL(req, res, store);
    return;
  }
  if (pathname === '/mcp' && method === 'POST') {
    await handleMcp(req, res, store);
    return;
  }
  const gitMatch = GIT_PATH.exec(pathname);
  if (gitMatch) {
    await handleGit(req, res, url, store, gitMatch[1], gitMatch[2], gitMatch[3]);
    return;
  }
  sendError(res, 404, `Not Found: ${pathname}`);
}

/**
 * One request, either transport: handleRequest plus the error path. The
 * returned promise resolves once the response is written, so the raw-TCP
 * server can order pipelined responses through it.
 */
function dispatchRequest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  return handleRequest(req, res, store).catch((err) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof StoreError) sendError(res, err.status, err.message);
    else sendError(res, 500, err instanceof Error ? err.message : 'Internal error');
  });
}

export function createForgeServer(store: Store = new Store()): net.Server {
  // C4 experiment: raw TCP is the default on this branch. FORGE_HTTP=1 keeps
  // the node:http transport for differential testing (same code, both
  // transports). http.Server extends net.Server, so the return type covers
  // both.
  if (process.env.FORGE_HTTP === '1') {
    return http.createServer((req, res) => {
      void dispatchRequest(req, res, store);
    });
  }
  return createRawTcpServer((req, res) => dispatchRequest(req as IncomingMessage, res as ServerResponse, store));
}

/** Start the forge on an ephemeral (or given) port; returns the live server. */
export function listenForge(
  port = 0,
  store: Store = new Store(),
): Promise<{ server: net.Server; store: Store; port: number }> {
  const server = createForgeServer(store);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('server did not bind to a port'));
        return;
      }
      resolve({ server, store, port: address.port });
    });
  });
}
