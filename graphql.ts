// graphql.ts — A small GraphQL parser and executor for the shapes the
// github-mcp-server-style documents send: queries, mutations, variables,
// aliases, inline fragments, input objects, lists, enums, and __type
// introspection. No schema language, no directives: just enough of the
// language to answer the eighteen documents faithfully, with unknown fields
// reported as errors (HTTP 200, `errors` array) the way GraphQL does.
import {
  diffFlatTrees,
  flattenTree,
  parseCommit,
  type ObjectStore,
} from './git.ts';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  StoreError,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// global ids (opaque, typed, reversible)
// ---------------------------------------------------------------------------

export function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

export function ungid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    // Re-encoding must round-trip, so a random string is not a valid id.
    if (Buffer.from(text, 'utf8').toString('base64') !== id) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  const isDigit = (ch: string): boolean => /[0-9]/.test(ch);
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$!=@[]'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // Block strings (""") are not expected; a plain string suffices here.
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = input[i + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'u' && i + 5 < input.length) {
            value += String.fromCharCode(Number.parseInt(input.slice(i + 2, i + 6), 16));
            i += 4;
          } else value += esc;
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      if (i >= input.length) throw new Error('unterminated string');
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '-' || isDigit(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && isDigit(input[j])) j += 1;
      let isFloat = false;
      if (input[j] === '.' && isDigit(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && isDigit(input[j])) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && isDigit(input[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < input.length && isNameChar(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// parser (AST)
// ---------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

export interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

export interface FragmentSpreadNode {
  kind: 'fragmentSpread';
  name: string;
}

export type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

export interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of query');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}" but got ${JSON.stringify(token)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name but got ${JSON.stringify(token)}`);
    if (value !== undefined && token.value !== value) {
      throw new Error(`expected name "${value}" but got "${token.value}"`);
    }
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.parseArguments();
      }
    }
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token?.kind === 'punct' && token.value === '{') {
        operations.push({
          operation: 'query',
          name: null,
          variables: [],
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const operation = token.value as 'query' | 'mutation';
        this.next();
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value as string;
        const variables = this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({
          operation,
          name,
          variables,
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (token?.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token)} at document level`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const out: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (!(this.peek()?.kind === 'punct' && this.peek()?.value === '(')) return out;
    this.next();
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      out.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return out;
  }

  private parseType(): void {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '[') {
      this.parseType();
      this.expectPunct(']');
    } else if (token.kind !== 'name') {
      throw new Error(`expected a type but got ${JSON.stringify(token)}`);
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        const name = this.next().value as string;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    const selectionSet =
      this.peek()?.kind === 'punct' && this.peek()?.value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (!(this.peek()?.kind === 'punct' && this.peek()?.value === '(')) return args;
    this.next();
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

export function parseGraphQL(query: string): DocumentNode {
  return new Parser(tokenize(query)).parseDocument();
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

/** A resolved value carries its runtime type so fragments and fields check. */
type View =
  | { __type: 'Query' }
  | { __type: 'Mutation' }
  | { __type: 'User'; login: string; id: number }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Ref'; name: string }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'IssueConnection'; repo: Repo; items: Issue[]; pageInfo: PageInfo }
  | { __type: 'PullRequest'; repo: Repo; pr: PullRequest }
  | { __type: 'PullRequestConnection'; repo: Repo; items: PullRequest[]; pageInfo: PageInfo }
  | { __type: 'PullRequestChangedFileConnection'; items: FileView[]; pageInfo: PageInfo }
  | { __type: 'PullRequestChangedFile'; path: string; additions: number; deletions: number }
  | { __type: 'PageInfo'; info: PageInfo }
  | { __type: '__Type'; name: string; fields: string[]; enumValues: string[] | null }
  | { __type: '__Field'; name: string }
  | { __type: '__EnumValue'; name: string }
  | { __type: 'CreateIssuePayload'; issue: Issue | null; repo: Repo | null }
  | { __type: 'CloseIssuePayload'; issue: Issue | null; repo: Repo | null }
  | { __type: 'CreatePullRequestPayload'; pr: PullRequest | null; repo: Repo | null }
  | { __type: 'MergePullRequestPayload'; pr: PullRequest | null; repo: Repo | null }
  | { __type: 'AddCommentPayload'; edge: { node: CommentView } | null }
  | { __type: 'IssueCommentEdge'; node: CommentView }
  | { __type: 'IssueComment'; comment: CommentView };

interface CommentView {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

/** The fields each type answers; anything else is an unknown-field error. */
const KNOWN_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
    'pullRequest', 'description', 'createdAt', 'updatedAt',
  ],
  Ref: ['id', 'name'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName',
    'baseRefName', 'mergeable', 'files', 'createdAt', 'updatedAt', 'mergedAt',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt'],
};

/** Introspection data: the field and enum-value names each type exposes. */
const TYPE_INFO: Record<string, { fields: string[]; enumValues: string[] | null; kind: string }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt'],
    enumValues: null,
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName',
      'baseRefName', 'mergeable', 'files', 'createdAt', 'updatedAt', 'mergedAt',
    ],
    enumValues: null,
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
      'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
      'pullRequest', 'description', 'createdAt', 'updatedAt',
    ],
    enumValues: null,
  },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'], enumValues: null },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
};

interface ExecutorContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: DocumentNode['fragments'];
  errors: Array<{ message: string }>;
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => valueOf(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function issueCursor(issue: Issue): string {
  return Buffer.from(`issue:${issue.number}`, 'utf8').toString('base64');
}

function prCursor(pr: PullRequest): string {
  return Buffer.from(`pr:${pr.number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string | undefined, prefix: string): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith(`${prefix}:`)) return null;
    const n = Number.parseInt(text.slice(prefix.length + 1), 10);
    return Number.isSafeInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/** Slice an ordered list by `after` cursor and `first` count; build pageInfo. */
function paginate<T extends { number: number }>(
  ordered: readonly T[],
  args: Record<string, unknown>,
  cursorOf: (item: T) => string,
  prefix: string,
): { items: T[]; pageInfo: PageInfo } {
  const afterNumber = cursorNumber(asString(args.after) || undefined, prefix);
  let start = 0;
  if (afterNumber !== null) {
    const index = ordered.findIndex((item) => item.number === afterNumber);
    start = index < 0 ? 0 : index + 1;
  }
  const first = asNumber(args.first);
  const end = first === undefined ? ordered.length : Math.min(ordered.length, start + Math.max(0, first));
  const items = ordered.slice(start, end);
  return {
    items,
    pageInfo: {
      hasNextPage: end < ordered.length,
      hasPreviousPage: start > 0,
      startCursor: items.length > 0 ? cursorOf(items[0]) : null,
      endCursor: items.length > 0 ? cursorOf(items[items.length - 1]) : null,
    },
  };
}

function repoOfId(store: Store, databaseId: number): Repo | null {
  return store.getRepoById(databaseId);
}

function decodeRepoId(store: Store, globalId: string): Repo | null {
  const decoded = ungid(globalId);
  if (!decoded || decoded.kind !== 'Repository') return null;
  const databaseId = Number.parseInt(decoded.parts[0], 10);
  if (!Number.isSafeInteger(databaseId)) return null;
  return repoOfId(store, databaseId);
}

/**
 * Resolve one field of one view. Returns a scalar, a view, an array of views,
 * or null. Unknown fields record an error and resolve to null.
 */
function resolveField(
  view: View,
  field: FieldNode,
  ctx: ExecutorContext,
): unknown {
  const typeName = view.__type;
  if (field.name === '__typename') return typeName;
  const known = KNOWN_FIELDS[typeName] ?? [];
  if (!known.includes(field.name)) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return null;
  }
  const args = argsOf(field, ctx.variables);
  const store = ctx.store;

  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') {
        return { __type: 'User', login: VIEWER_LOGIN, id: VIEWER_ID } satisfies View;
      }
      if (field.name === 'repository') {
        const repo = store.getRepo(asString(args.owner), asString(args.name));
        return repo ? ({ __type: 'Repository', repo } satisfies View) : null;
      }
      if (field.name === 'node') {
        const decoded = ungid(asString(args.id));
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = decodeRepoId(store, asString(args.id));
          return repo ? ({ __type: 'Repository', repo } satisfies View) : null;
        }
        if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
          const repo = repoOfId(store, Number.parseInt(decoded.parts[0], 10));
          if (!repo) return null;
          const number = Number.parseInt(decoded.parts[1], 10);
          if (decoded.kind === 'Issue') {
            const issue = repo.issues.get(number);
            return issue ? ({ __type: 'Issue', repo, issue } satisfies View) : null;
          }
          const pr = repo.prs.get(number);
          return pr ? ({ __type: 'PullRequest', repo, pr } satisfies View) : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const info = TYPE_INFO[asString(args.name)];
        if (!info) return null;
        return {
          __type: '__Type',
          name: asString(args.name),
          fields: info.fields,
          enumValues: info.enumValues,
        } satisfies View;
      }
      return null;
    }
    case 'Mutation': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      if (field.name === 'createIssue') {
        const repo = decodeRepoId(store, asString(input.repositoryId));
        if (!repo) {
          ctx.errors.push({ message: 'createIssue: repository not found' });
          return { __type: 'CreateIssuePayload', issue: null, repo: null } satisfies View;
        }
        try {
          const issue = store.createIssue(repo, {
            title: asString(input.title),
            body: asString(input.body),
          });
          return { __type: 'CreateIssuePayload', issue, repo } satisfies View;
        } catch (err) {
          ctx.errors.push({ message: err instanceof Error ? err.message : 'createIssue failed' });
          return { __type: 'CreateIssuePayload', issue: null, repo } satisfies View;
        }
      }
      if (field.name === 'closeIssue') {
        const decoded = ungid(asString(input.issueId));
        const repo = decoded ? repoOfId(store, Number.parseInt(decoded.parts[0], 10)) : null;
        const number = decoded ? Number.parseInt(decoded.parts[1], 10) : Number.NaN;
        if (!repo || !Number.isSafeInteger(number) || !repo.issues.has(number)) {
          ctx.errors.push({ message: 'closeIssue: issue not found' });
          return { __type: 'CloseIssuePayload', issue: null, repo } satisfies View;
        }
        const issue = store.setIssueState(repo, number, 'closed');
        return { __type: 'CloseIssuePayload', issue, repo } satisfies View;
      }
      if (field.name === 'createPullRequest') {
        const repo = decodeRepoId(store, asString(input.repositoryId));
        if (!repo) {
          ctx.errors.push({ message: 'createPullRequest: repository not found' });
          return { __type: 'CreatePullRequestPayload', pr: null, repo: null } satisfies View;
        }
        try {
          const pr = store.createPullRequest(repo, {
            title: asString(input.title),
            body: asString(input.body),
            head: asString(input.headRefName),
            base: asString(input.baseRefName),
          });
          return { __type: 'CreatePullRequestPayload', pr, repo } satisfies View;
        } catch (err) {
          ctx.errors.push({ message: err instanceof Error ? err.message : 'createPullRequest failed' });
          return { __type: 'CreatePullRequestPayload', pr: null, repo } satisfies View;
        }
      }
      if (field.name === 'mergePullRequest') {
        const decoded = ungid(asString(input.pullRequestId));
        const repo = decoded ? repoOfId(store, Number.parseInt(decoded.parts[0], 10)) : null;
        const number = decoded ? Number.parseInt(decoded.parts[1], 10) : Number.NaN;
        if (!repo || !Number.isSafeInteger(number) || !repo.prs.has(number)) {
          ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
          return { __type: 'MergePullRequestPayload', pr: null, repo } satisfies View;
        }
        try {
          store.mergePullRequest(repo, number);
        } catch (err) {
          ctx.errors.push({ message: err instanceof Error ? err.message : 'mergePullRequest failed' });
          return { __type: 'MergePullRequestPayload', pr: repo.prs.get(number) ?? null, repo } satisfies View;
        }
        return { __type: 'MergePullRequestPayload', pr: repo.prs.get(number) ?? null, repo } satisfies View;
      }
      if (field.name === 'addComment') {
        const decoded = ungid(asString(input.subjectId));
        const repo = decoded ? repoOfId(store, Number.parseInt(decoded.parts[0], 10)) : null;
        const number = decoded ? Number.parseInt(decoded.parts[1], 10) : Number.NaN;
        if (!repo || !Number.isSafeInteger(number) || !repo.issues.has(number)) {
          ctx.errors.push({ message: 'addComment: subject not found' });
          return { __type: 'AddCommentPayload', edge: null } satisfies View;
        }
        const comment = store.addComment(repo, number, asString(input.body));
        const node: CommentView = {
          id: gid('IssueComment', repo.id, comment.id),
          body: comment.body,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
        };
        return { __type: 'AddCommentPayload', edge: { node } } satisfies View;
      }
      return null;
    }
    case 'User': {
      if (field.name === 'id') return gid('User', view.id);
      if (field.name === 'login') return view.login;
      if (field.name === 'name') return VIEWER_NAME;
      if (field.name === 'email') return VIEWER_EMAIL;
      return null;
    }
    case 'Repository': {
      const repo = view.repo;
      switch (field.name) {
        case 'id': return gid('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return { __type: 'User', login: repo.owner, id: VIEWER_ID } satisfies View;
        case 'defaultBranchRef': return { __type: 'Ref', name: repo.defaultBranch } satisfies View;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.updatedAt;
        case 'issue': {
          const issue = repo.issues.get(asNumber(args.number) ?? -1);
          return issue ? ({ __type: 'Issue', repo, issue } satisfies View) : null;
        }
        case 'issues': {
          let ordered = [...repo.issues.values()].sort((a, b) => a.seq - b.seq);
          const states = args.states as string[] | undefined;
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((s) => s.toLowerCase()));
            ordered = ordered.filter((issue) => wanted.has(issue.state));
          }
          const orderBy = args.orderBy as Record<string, unknown> | undefined;
          if (orderBy && orderBy.direction === 'DESC') ordered = [...ordered].reverse();
          const page = paginate(ordered, args, issueCursor, 'issue');
          return { __type: 'IssueConnection', repo, items: page.items, pageInfo: page.pageInfo } satisfies View;
        }
        case 'pullRequests': {
          const ordered = [...repo.prs.values()].sort((a, b) => a.seq - b.seq);
          const page = paginate(ordered, args, prCursor, 'pr');
          return {
            __type: 'PullRequestConnection',
            repo,
            items: page.items,
            pageInfo: page.pageInfo,
          } satisfies View;
        }
        case 'pullRequest': {
          const pr = repo.prs.get(asNumber(args.number) ?? -1);
          return pr ? ({ __type: 'PullRequest', repo, pr } satisfies View) : null;
        }
        default: return null;
      }
    }
    case 'Ref': {
      if (field.name === 'id') return gid('Ref', view.name);
      if (field.name === 'name') return view.name;
      return null;
    }
    case 'Issue': {
      const issue = view.issue;
      switch (field.name) {
        case 'id': return gid('Issue', view.repo.id, issue.number);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state.toUpperCase();
        case 'body': return issue.body;
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        default: return null;
      }
    }
    case 'IssueConnection': {
      switch (field.name) {
        case 'nodes':
          return view.items.map((issue) => ({ __type: 'Issue', repo: view.repo, issue }) satisfies View);
        case 'edges':
          return view.items.map((issue) => ({ __type: 'Issue', repo: view.repo, issue }) satisfies View);
        case 'pageInfo': return { __type: 'PageInfo', info: view.pageInfo } satisfies View;
        case 'totalCount': return view.items.length;
        default: return null;
      }
    }
    case 'PullRequest': {
      const pr = view.pr;
      const repo = view.repo;
      switch (field.name) {
        case 'id': return gid('PullRequest', repo.id, pr.number);
        case 'number': return pr.number;
        case 'title': return pr.title;
        case 'body': return pr.body;
        case 'state': return pr.merged ? 'MERGED' : pr.state.toUpperCase();
        case 'merged': return pr.merged;
        case 'headRefName': return pr.headRef;
        case 'baseRefName': return pr.baseRef;
        case 'mergeable': return store.mergeableState(repo, pr);
        case 'createdAt': return pr.createdAt;
        case 'updatedAt': return pr.updatedAt;
        case 'mergedAt': return pr.mergedAt;
        case 'files': {
          const objectStore: ObjectStore = { get: (oid) => repo.objects.get(oid) };
          const baseTip = store.branchTip(repo, pr.baseRef);
          const headTip = store.branchTip(repo, pr.headRef);
          const baseTree = baseTip ? parseCommit(objectStore.get(baseTip)!.data).tree : '';
          const headTree = headTip ? parseCommit(objectStore.get(headTip)!.data).tree : '';
          const baseFlat = baseTree ? flattenTree(objectStore, baseTree) : new Map();
          const headFlat = headTree ? flattenTree(objectStore, headTree) : new Map();
          const changes = diffFlatTrees(objectStore, baseFlat, headFlat);
          const items: FileView[] = changes.map((change) => ({
            path: change.path,
            additions: change.additions,
            deletions: change.deletions,
          }));
          const first = asNumber(args.first);
          const sliced = first === undefined ? items : items.slice(0, Math.max(0, first));
          return {
            __type: 'PullRequestChangedFileConnection',
            items: sliced,
            pageInfo: {
              hasNextPage: first !== undefined && items.length > sliced.length,
              hasPreviousPage: false,
              startCursor: null,
              endCursor: null,
            },
          } satisfies View;
        }
        default: return null;
      }
    }
    case 'PullRequestConnection': {
      switch (field.name) {
        case 'nodes':
          return view.items.map((pr) => ({ __type: 'PullRequest', repo: view.repo, pr }) satisfies View);
        case 'edges':
          return view.items.map((pr) => ({ __type: 'PullRequest', repo: view.repo, pr }) satisfies View);
        case 'pageInfo': return { __type: 'PageInfo', info: view.pageInfo } satisfies View;
        case 'totalCount': return view.items.length;
        default: return null;
      }
    }
    case 'PullRequestChangedFileConnection': {
      switch (field.name) {
        case 'nodes':
          return view.items.map((file) => ({ __type: 'PullRequestChangedFile', ...file }) satisfies View);
        case 'edges':
          return view.items.map((file) => ({ __type: 'PullRequestChangedFile', ...file }) satisfies View);
        case 'pageInfo': return { __type: 'PageInfo', info: view.pageInfo } satisfies View;
        case 'totalCount': return view.items.length;
        default: return null;
      }
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return view.path;
      if (field.name === 'additions') return view.additions;
      if (field.name === 'deletions') return view.deletions;
      return null;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return view.info.hasNextPage;
      if (field.name === 'hasPreviousPage') return view.info.hasPreviousPage;
      if (field.name === 'startCursor') return view.info.startCursor;
      if (field.name === 'endCursor') return view.info.endCursor;
      return null;
    }
    case '__Type': {
      if (field.name === 'name') return view.name;
      if (field.name === 'kind') return TYPE_INFO[view.name]?.kind ?? 'OBJECT';
      if (field.name === 'description') return null;
      if (field.name === 'fields') {
        return view.fields.map((name) => ({ __type: '__Field', name }) satisfies View);
      }
      if (field.name === 'enumValues') {
        return view.enumValues === null
          ? null
          : view.enumValues.map((name) => ({ __type: '__EnumValue', name }) satisfies View);
      }
      return null;
    }
    case '__Field': {
      if (field.name === 'name') return view.name;
      if (field.name === 'description') return null;
      return null;
    }
    case '__EnumValue': {
      if (field.name === 'name') return view.name;
      if (field.name === 'description') return null;
      return null;
    }
    case 'CreateIssuePayload': {
      if (field.name === 'clientMutationId') return null;
      if (field.name === 'issue') {
        return view.issue && view.repo
          ? ({ __type: 'Issue', repo: view.repo, issue: view.issue } satisfies View)
          : null;
      }
      return null;
    }
    case 'CloseIssuePayload': {
      if (field.name === 'clientMutationId') return null;
      if (field.name === 'issue') {
        return view.issue && view.repo
          ? ({ __type: 'Issue', repo: view.repo, issue: view.issue } satisfies View)
          : null;
      }
      return null;
    }
    case 'CreatePullRequestPayload': {
      if (field.name === 'clientMutationId') return null;
      if (field.name === 'pullRequest') {
        return view.pr && view.repo
          ? ({ __type: 'PullRequest', repo: view.repo, pr: view.pr } satisfies View)
          : null;
      }
      return null;
    }
    case 'MergePullRequestPayload': {
      if (field.name === 'clientMutationId') return null;
      if (field.name === 'pullRequest') {
        return view.pr && view.repo
          ? ({ __type: 'PullRequest', repo: view.repo, pr: view.pr } satisfies View)
          : null;
      }
      return null;
    }
    case 'AddCommentPayload': {
      if (field.name === 'clientMutationId') return null;
      if (field.name === 'commentEdge') {
        return view.edge ? ({ __type: 'IssueCommentEdge', node: view.edge.node } satisfies View) : null;
      }
      if (field.name === 'comment') {
        return view.edge ? ({ __type: 'IssueComment', comment: view.edge.node } satisfies View) : null;
      }
      return null;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return { __type: 'IssueComment', comment: view.node } satisfies View;
      if (field.name === 'cursor') return view.node.id;
      return null;
    }
    case 'IssueComment': {
      if (field.name === 'id') return view.comment.id;
      if (field.name === 'body') return view.comment.body;
      if (field.name === 'createdAt') return view.comment.createdAt;
      if (field.name === 'updatedAt') return view.comment.updatedAt;
      return null;
    }
    default:
      return null;
  }
}

interface FileView {
  path: string;
  additions: number;
  deletions: number;
}

function isView(value: unknown): value is View {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    '__type' in value &&
    typeof (value as { __type: unknown }).__type === 'string'
  );
}

/** Execute a selection set against one view, collecting errors. */
function executeSelectionSet(
  view: View,
  selections: readonly SelectionNode[],
  ctx: ExecutorContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition && fragment.typeCondition !== view.__type) continue;
      Object.assign(out, executeSelectionSet(view, fragment.selectionSet, ctx));
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition && selection.typeCondition !== view.__type) continue;
      Object.assign(out, executeSelectionSet(view, selection.selectionSet, ctx));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const resolved = resolveField(view, selection, ctx);
    if (selection.selectionSet === null || selection.selectionSet.length === 0) {
      out[key] = isView(resolved) ? null : resolved;
      continue;
    }
    if (resolved === null || resolved === undefined) {
      out[key] = null;
      continue;
    }
    if (Array.isArray(resolved)) {
      out[key] = resolved.map((item) =>
        isView(item) ? executeSelectionSet(item, selection.selectionSet!, ctx) : item,
      );
      continue;
    }
    if (isView(resolved)) {
      out[key] = executeSelectionSet(resolved, selection.selectionSet, ctx);
      continue;
    }
    out[key] = resolved;
  }
  return out;
}

/**
 * Execute one GraphQL request body ({query, variables, operationName}).
 * Returns the response object ({data} plus `errors` when anything failed).
 */
export function executeGraphQL(
  store: Store,
  body: { query?: unknown; variables?: unknown; operationName?: unknown },
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];
  if (typeof body.query !== 'string' || body.query.trim() === '') {
    return { data: null, errors: [{ message: 'GraphQL query must be a non-empty string' }] };
  }
  let document: DocumentNode;
  try {
    document = parseGraphQL(body.query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation =
    document.operations.find((op) => op.name === operationName) ??
    (operationName === null ? document.operations[0] : undefined);
  if (!operation) {
    return { data: null, errors: [{ message: `Unknown operation ${JSON.stringify(operationName)}` }] };
  }
  const variables: Record<string, unknown> = {};
  for (const variable of operation.variables) {
    if (variable.defaultValue !== null) variables[variable.name] = valueOf(variable.defaultValue, {});
  }
  if (body.variables && typeof body.variables === 'object' && !Array.isArray(body.variables)) {
    for (const [key, value] of Object.entries(body.variables as Record<string, unknown>)) {
      variables[key] = value;
    }
  }
  const ctx: ExecutorContext = { store, variables, fragments: document.fragments, errors };
  const root: View = operation.operation === 'mutation' ? { __type: 'Mutation' } : { __type: 'Query' };
  const data = executeSelectionSet(root, operation.selectionSet, ctx);
  return errors.length > 0 ? { data, errors } : { data };
}

export { StoreError };
