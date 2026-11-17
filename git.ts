// git.ts — Git object model, packfiles, pkt-lines, and history walks.
//
// A minimal, dependency-free implementation of the parts of git a small forge
// needs: object hashing, commit/tree/tag parsing and building, packfile read
// (including OFS_DELTA / REF_DELTA) and write (plain objects, no deltas),
// pkt-line framing, fetch closure computation with shallow boundaries, and
// three-way tree merges. Standard library only; no network, no filesystem.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** Anything that can answer "give me object <oid>". */
export interface ObjectStore {
  get(oid: string): GitObject | undefined;
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The SHA-1 id of a git object: sha1("<type> <size>\0" + bytes). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  // The header goes in as a string update: no throwaway Buffer per hash.
  return createHash('sha1').update(`${type} ${data.length}\0`, 'utf8').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim' | 'end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Encode one pkt-line: 4 hex digits of total length (header included) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 65520) throw new Error(`pkt-line payload of ${body.length} bytes is too large`);
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

/**
 * Parse pkt-lines from the start of `buffer`. Stops after the first flush (or
 * delim when `stopAtDelim` is set) and returns how many bytes were consumed,
 * so a caller (receive-pack) can treat the remainder as raw pack bytes.
 * Throws on malformed framing instead of looping forever.
 */
export function parsePktLines(
  buffer: Buffer,
  options: { stopAfterFlush?: boolean } = {},
): { packets: Pkt[]; consumed: number } {
  const packets: Pkt[] = [];
  let offset = 0;
  const stopAfterFlush = options.stopAfterFlush !== false;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      if (stopAfterFlush) break;
      continue;
    }
    if (header === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (header === '0002') {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    const length = Number.parseInt(header, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > buffer.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(header)} at offset ${offset}`);
    }
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

/** The data payloads of parsed packets as UTF-8 lines (trailing newline kept). */
export function pktTextLines(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's raw bytes. Continuation lines (gpgsig) are skipped. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith(' ')) continue; // continuation of a multi-line header
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's raw bytes from its fields. */
export function buildCommit(info: CommitInfo): Buffer {
  let out = `tree ${info.tree}\n`;
  for (const parent of info.parents) out += `parent ${parent}\n`;
  out += `author ${info.author}\n`;
  out += `committer ${info.committer}\n`;
  out += `\n${info.message}`;
  return Buffer.from(out, 'utf8');
}

/** Format one identity line: `Name <email> <unix seconds> +0000`. */
export function identity(name: string, email: string, unixSeconds: number): string {
  return `${name} <${email}> ${Math.trunc(unixSeconds)} +0000`;
}

// ---------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode terminator');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry has no name terminator');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/**
 * Git's tree-entry order: names compared as bytes, with directories compared
 * as if their name ended in '/'. This matters: a wrong order changes the tree
 * hash and breaks clone verification.
 */
export function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const aName = a.mode === '40000' ? `${a.name}/` : a.name;
  const bName = b.mode === '40000' ? `${b.name}/` : b.name;
  return Buffer.compare(Buffer.from(aName, 'utf8'), Buffer.from(bName, 'utf8'));
}

/** Build a tree object's raw bytes; entries are sorted git-style first. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** The empty tree's id, computed rather than memorized. */
export function emptyTreeOid(): string {
  return hashObject('tree', Buffer.alloc(0));
}

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

export interface TagInfo {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------
// building trees from a flat file map
// ---------------------------------------------------------------------------

/**
 * Build every tree object for a flat path -> blob map, returning the root
 * tree's id and all new tree objects (blobs are the caller's; they are
 * already stored). Directories are created implicitly.
 */
export function buildTreesFromFiles(
  files: ReadonlyMap<string, { oid: string; mode: string }>,
): { rootOid: string; trees: Map<string, GitObject> } {
  const trees = new Map<string, GitObject>();

  const buildLevel = (prefix: string): string => {
    // prefix is '' for the root, otherwise 'dir/sub/' (trailing slash).
    const direct = new Map<string, { oid: string; mode: string }>();
    const subdirs = new Set<string>();
    for (const [path, file] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) direct.set(rest, file);
      else subdirs.add(rest.slice(0, slash));
    }
    const entries: TreeEntry[] = [];
    for (const [name, file] of direct) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const name of subdirs) {
      const childOid = buildLevel(`${prefix}${name}/`);
      entries.push({ mode: '40000', name, oid: childOid });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    trees.set(oid, { type: 'tree', data });
    return oid;
  };

  return { rootOid: buildLevel(''), trees };
}

/** Flatten a tree (recursively) into path -> blob entries. */
export function flattenTree(
  store: ObjectStore,
  treeOid: string,
): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = store.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** The tree object id at `path` inside a tree ('' = the tree itself), or null. */
export function subtreeAt(store: ObjectStore, treeOid: string, path: string): string | null {
  if (path === '' || path === '/') return treeOid;
  const parts = path.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (const part of parts) {
    const obj = store.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === part);
    if (!entry || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return current;
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Inflate one zlib stream starting at `offset`; reports where it ends. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      // Copy from the base: offset/size bytes follow per the opcode bitmask.
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) {
    throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  }
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: GitObjectType;
  resolved?: Buffer;
  oid?: string;
}

function readPackEntryHeader(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including
 * OFS_DELTA and REF_DELTA. `resolveBase` supplies a base object a thin pack
 * leaves out (the receiver already has it). Every object's SHA-1 is
 * recomputed from its resolved bytes.
 */
export function readPack(
  pack: Buffer,
  options: { resolveBase?: (oid: string) => GitObject | undefined } = {},
): { objects: Map<string, GitObject>; checksumOk: boolean; declaredCount: number } {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.readUInt32BE(0) !== 0x5041434b) throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  // One view of the pack body, reused by the trailer check and every entry
  // inflate (instead of a fresh subarray per entry).
  const body = pack.subarray(0, trailerStart);
  // Compare the trailer as bytes: no hex encode on either side.
  const trailer = pack.subarray(trailerStart);
  const computedTrailer = createHash('sha1').update(body).digest();
  const checksumOk = trailer.equals(computedTrailer);

  const raw: RawPackEntry[] = [];
  let hasDeltas = false;
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackEntryHeader(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      hasDeltas = true;
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      hasDeltas = true;
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(body, offset);
    if (inflated.data.length !== header.size) {
      throw new Error(
        `pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`,
      );
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const objects = new Map<string, GitObject>();
  if (!hasDeltas) {
    // Fast path: plain packs (every push the benchmark sends) need no delta
    // resolution — each entry hashes straight to its object id.
    for (const entry of raw) {
      const type = CODE_TYPE[entry.typeCode];
      const oid = hashObject(type, entry.data);
      if (!objects.has(oid)) objects.set(oid, { type, data: entry.data });
    }
    return { objects, checksumOk, declaredCount };
  }

  const byOffset = new Map<number, RawPackEntry>();
  for (const entry of raw) byOffset.set(entry.offset, entry);
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, checksumOk, declaredCount };
}

/** Encode one pack entry header (type + size varint). */
function packEntryHeader(type: GitObjectType, size: number): Buffer {
  const typeCode = TYPE_CODE[type];
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  let remaining = size >> 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/**
 * Build a packfile version 2 from plain objects (no deltas): header, one
 * zlib-deflated entry per object, and the SHA-1 trailer over all prior bytes.
 * Deflate level 1: pack entries here are small (a clone's shallow pack is a
 * few KiB), and level 1 compresses them ~2x faster than the default 6 for a
 * slightly larger stream — the client verifies the checksum, never the size.
 */
export function writePack(objects: ReadonlyArray<{ type: GitObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// history walks
// ---------------------------------------------------------------------------

/** All commits reachable from `tip` (all parents), newest-first by discovery. */
export function walkCommits(store: ObjectStore, tip: string, limit = 10000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  // Index pointer, not shift(): shift() is O(n) per call and this walk runs
  // once per fetch, so a deep history would pay O(n^2).
  for (let head = 0; head < queue.length && out.length < limit; head += 1) {
    const oid = queue[head];
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(obj.data).parents) {
      if (!seen.has(parent)) queue.push(parent);
    }
  }
  return out;
}

/** True when `ancestor` is reachable from `descendant` (or they are equal). */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  for (let head = 0; head < queue.length; head += 1) {
    const oid = queue[head];
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) queue.push(parent);
    }
  }
  return false;
}

/** The first common ancestor of two commits (breadth-first from `b`). */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsA = new Set(walkCommits(store, a));
  const seen = new Set<string>();
  const queue: string[] = [b];
  for (let head = 0; head < queue.length; head += 1) {
    const oid = queue[head];
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!seen.has(parent)) queue.push(parent);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// fetch closure
// ---------------------------------------------------------------------------

export interface FetchClosure {
  /** Objects the server must send (commits, trees, blobs, tags). */
  objects: Map<string, GitObject>;
  /** Commits at the depth boundary that were sent (shallow-info lines). */
  boundaries: string[];
  /** Client-shallow commits whose parents are now sent (unshallow lines). */
  unshallows: string[];
}

/**
 * Compute what a fetch must send: the closure of `wants` (limited to `depth`
 * commits deep when given), minus the closure of `haves`. A have the client
 * declared shallow contributes only itself and its tree — the client does
 * not have its parents. Boundaries are reported only when they are sent:
 * a boundary the client already holds must not be re-marked shallow.
 */
export function fetchClosure(
  store: ObjectStore,
  wants: readonly string[],
  options: {
    depth?: number;
    haves?: readonly string[];
    clientShallow?: ReadonlySet<string>;
  } = {},
): FetchClosure {
  const depth = options.depth;
  const clientShallow = options.clientShallow ?? new Set<string>();

  // Collect one commit and its whole tree (commit + tree + subtrees + blobs).
  const addTreeClosure = (treeOid: string, into: Map<string, GitObject>): void => {
    const queue: string[] = [treeOid];
    const seenTrees = new Set<string>();
    for (let head = 0; head < queue.length; head += 1) {
      const oid = queue[head];
      if (seenTrees.has(oid)) continue;
      seenTrees.add(oid);
      const obj = store.get(oid);
      if (!obj || obj.type !== 'tree') continue;
      into.set(oid, obj);
      for (const entry of parseTree(obj.data)) {
        const child = store.get(entry.oid);
        if (!child) continue;
        if (entry.mode === '40000') queue.push(entry.oid);
        else into.set(entry.oid, child);
      }
    }
  };

  // Walk commits from `starts`; `maxDepth` commits deep (0 = unlimited).
  // Returns the commit set, the boundary commits, and every object touched.
  const collect = (
    starts: readonly string[],
    maxDepth: number,
  ): { commits: Set<string>; objects: Map<string, GitObject>; boundaries: Set<string> } => {
    const commits = new Set<string>();
    const objects = new Map<string, GitObject>();
    const boundaries = new Set<string>();
    const queue: Array<{ oid: string; depth: number }> = starts.map((oid) => ({ oid, depth: 1 }));
    for (let head = 0; head < queue.length; head += 1) {
      const { oid, depth: at } = queue[head];
      if (commits.has(oid)) continue;
      const obj = store.get(oid);
      if (!obj) continue;
      if (obj.type === 'tag') {
        objects.set(oid, obj);
        const target = parseTag(obj.data).object;
        const targetObj = store.get(target);
        if (targetObj?.type === 'commit') queue.push({ oid: target, depth: at });
        else if (targetObj) objects.set(target, targetObj);
        continue;
      }
      if (obj.type !== 'commit') {
        objects.set(oid, obj);
        continue;
      }
      commits.add(oid);
      objects.set(oid, obj);
      const info = parseCommit(obj.data);
      addTreeClosure(info.tree, objects);
      if (maxDepth > 0 && at >= maxDepth) {
        boundaries.add(oid);
        continue;
      }
      for (const parent of info.parents) {
        if (!commits.has(parent)) queue.push({ oid: parent, depth: at + 1 });
      }
    }
    return { commits, objects, boundaries };
  };

  // What the client already has: full closure of ordinary haves, depth-1
  // closure of shallow haves.
  const excluded = new Map<string, GitObject>();
  const haves = options.haves ?? [];
  const fullHaves = haves.filter((oid) => !clientShallow.has(oid));
  const shallowHaves = haves.filter((oid) => clientShallow.has(oid));
  if (fullHaves.length > 0) {
    for (const [oid, obj] of collect(fullHaves, 0).objects) excluded.set(oid, obj);
  }
  if (shallowHaves.length > 0) {
    for (const [oid, obj] of collect(shallowHaves, 1).objects) excluded.set(oid, obj);
  }

  const wanted = collect(wants, depth ?? 0);
  const objects = new Map<string, GitObject>();
  for (const [oid, obj] of wanted.objects) {
    if (!excluded.has(oid)) objects.set(oid, obj);
  }
  const boundaries = [...wanted.boundaries].filter((oid) => objects.has(oid));

  // A client-shallow commit is unshallowed when at least one of its parents
  // is in the send set (or it is sent together with its parents).
  const unshallows: string[] = [];
  for (const oid of clientShallow) {
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length === 0) continue;
    if (parents.some((parent) => objects.has(parent))) unshallows.push(oid);
    else if (objects.has(oid) && !wanted.boundaries.has(oid)) unshallows.push(oid);
  }
  return { objects, boundaries, unshallows };
}

/** Which of `haves` are ancestors of any of `wants` (for ACK lines). */
export function commonHaves(
  store: ObjectStore,
  wants: readonly string[],
  haves: readonly string[],
): string[] {
  // A fresh clone has no haves: skip the history walk entirely instead of
  // walking every commit just to filter an empty list.
  if (haves.length === 0) return [];
  const reachable = new Set<string>();
  for (const want of wants) {
    for (const oid of walkCommits(store, want)) reachable.add(oid);
  }
  return haves.filter((have) => reachable.has(have));
}

// ---------------------------------------------------------------------------
// tree diff and three-way merge
// ---------------------------------------------------------------------------

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

function lineCount(data: Buffer | undefined): number {
  if (!data || data.length === 0) return 0;
  const text = data.toString('utf8');
  const parts = text.split('\n');
  return parts.length - (text.endsWith('\n') ? 1 : 0);
}

/** Diff two flat file maps; additions/deletions are line counts. */
export function diffFlatTrees(
  store: ObjectStore,
  base: ReadonlyMap<string, { oid: string; mode: string }>,
  head: ReadonlyMap<string, { oid: string; mode: string }>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before && !after) {
      changes.push({
        path,
        status: 'removed',
        additions: 0,
        deletions: lineCount(store.get(before.oid)?.data),
      });
    } else if (!before && after) {
      changes.push({
        path,
        status: 'added',
        additions: lineCount(store.get(after.oid)?.data),
        deletions: 0,
      });
    } else if (before && after && before.oid !== after.oid) {
      changes.push({
        path,
        status: 'modified',
        additions: lineCount(store.get(after.oid)?.data),
        deletions: lineCount(store.get(before.oid)?.data),
      });
    }
  }
  return changes;
}

/**
 * Three-way merge of flat file maps. A path changed on both sides from the
 * base to different results is a conflict; everything else follows the
 * side that changed (or either side when both agree).
 */
export function threeWayMerge(
  base: ReadonlyMap<string, { oid: string; mode: string }>,
  ours: ReadonlyMap<string, { oid: string; mode: string }>,
  theirs: ReadonlyMap<string, { oid: string; mode: string }>,
): { merged: Map<string, { oid: string; mode: string }>; conflicts: string[] } {
  const merged = new Map<string, { oid: string; mode: string }>();
  const conflicts: string[] = [];
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const same = (x?: { oid: string }, y?: { oid: string }): boolean =>
      (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
    if (same(o, t)) {
      if (o) merged.set(path, o);
    } else if (same(b, o)) {
      if (t) merged.set(path, t);
    } else if (same(b, t)) {
      if (o) merged.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  return { merged, conflicts };
}
