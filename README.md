# forge — a self-contained GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/alifrestu519-hub/puddle-joy/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/alifrestu519-hub/puddle-joy/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A single-process git forge written in TypeScript (Node 22+, standard library
only, no network, no filesystem). It serves, from one in-memory store:

- **git smart HTTP** — `upload-pack` protocol v2 (`ls-refs`, `fetch` with
  shallow/deepen) and v0, `receive-pack` v0 with report-status and
  fast-forward enforcement. Objects are real SHA-1-addressed git objects,
  so clones verify byte-for-byte. Packs are read (OFS_DELTA and REF_DELTA
  included) and written (plain objects, no deltas).
- **REST v3** under `/api/v3` — repositories, branches, commits, refs,
  contents (create/read/update/delete), labels, issues (+ comments), and
  pull requests (create/list/files/squash-merge with three-way conflict
  detection). Paginated lists carry `Link` headers.
- **GraphQL** at `/api/graphql` — `viewer`, `repository`, `node`, `__type`
  introspection, issue/PR connections with cursor pagination, and the
  `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` /
  `addComment` mutations. Batching (an array of operations) is supported.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP: `server/discover`,
  `initialize`, and the six `github-mcp-server` tools (`create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`).

Authentication is a bearer token from `MAKEFUN_SHOP_TOKEN`, required on
every endpoint except `/healthz`. When the variable is unset (local
development), authentication is not enforced.

## Files

- `main.ts` — trial lifecycle: listen on an ephemeral port, register with
  `$MAKEFUN_ENV_URL`, poll `/done`, exit.
- `app.ts` — the HTTP server: routing, REST, git smart HTTP, MCP, GraphQL.
- `store.ts` — the in-memory model: repositories, refs, issues, pull
  requests, labels, comments, and the squash-merge operation.
- `git.ts` — git objects, packfiles, pkt-lines, fetch closure, history
  walks, three-way tree merges.
- `graphql.ts` — a small GraphQL parser and executor.

## Running locally

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types main.ts
# needs MAKEFUN_ENV_URL; for a bare server use app.ts instead:
MAKEFUN_SHOP_TOKEN=test-token node -e \
  "import('./app.ts').then(async (m) => { const { port } = await m.listenForge(0); console.log('listening on', port); })"
```

Then point the kit's runner at it:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token test-token
```

## Design notes

- The authenticated user is the scenario viewer (`adaiversen`); only that
  owner's repositories exist, and any other owner answers 404.
- Issues and pull requests share one numbering sequence per repository,
  like GitHub. Repository, issue, and pull-request ids are stable integers;
  GraphQL global ids are base64 of a typed `Kind:parts` string.
- A contents PUT to a branch that does not exist yet creates the branch
  from the default branch's tip.
- Squash merges compute a real three-way merge (merge-base, base tip, head
  tip); a path changed on both sides to different results is a 405.
- Every response carries `X-GitHub-Request-Id`; errors are JSON with a
  `message` field, never HTML.

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=06djxp1d&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
