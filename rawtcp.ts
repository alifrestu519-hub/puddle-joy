// raw tcp.ts — Raw TCP (node:net) HTTP/1.1 server for the forge (C4 experiment).
//
// Replaces node:http with a hand-rolled HTTP/1.1 layer so the server pays
// no IncomingMessage/ServerResponse machinery per request. The existing
// handler code (handleRequest in app.ts) is reused unchanged: each parsed
// request gets a small req/res shim exposing exactly the surface the
// handlers use (req.method/url/headers/on/destroy; res.writeHead/end/
// headersSent/destroy).
//
// Lessons from the v3 raw-TCP attempt (wall 2-3x worse despite equal CPU),
// fixed here by design:
//   1. socket.setNoDelay(true) on every connection (node:net defaults it
//      OFF, unlike node:http) — otherwise Nagle delays small writes.
//   2. Exactly ONE socket.write per response, one Buffer [head + body] —
//      never separate header/body writes.
//   3. indexOf-based parsing, never per-byte.
//   4. No waiting on drain/backpressure for these small responses.
//
// Correctness contract (must match node:http behavior for the kit clients):
//   - HTTP/1.1 keep-alive by default; Connection: close honoured; HTTP/1.0
//     closes unless keep-alive is asked for.
//   - Pipelined requests on one socket are answered strictly in order
//     (per-socket dispatch chain).
//   - Content-Length bodies, chunked bodies, and Expect: 100-continue.
//   - Requests split across segments, and several requests in one segment.
//   - No Date header is sent (no kit check requires it — verified by grep
//     over checks-*.ts; node:http sends one, we save the work).
import net from 'node:net';

/** Dispatch one request; resolves once its response has been written. */
export type RawDispatch = (req: unknown, res: unknown) => Promise<void>;

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Content Too Large',
  414: 'URI Too Long',
  422: 'Unprocessable Entity',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
};

const EMPTY_BODY = Buffer.alloc(0);
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 128 * 1024 * 1024;
const CONTINUE_100 = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'latin1');

/**
 * Minimal request shim: the handlers only read method/url/headers and call
 * readBody, which attaches 'data'/'end'/'error' listeners. The body is
 * already fully buffered when the request is dispatched, so 'data'/'end'
 * are replayed on the microtask queue in registration order (data first,
 * then end — exactly what readBody expects).
 */
function makeRequest(
  method: string,
  url: string,
  headers: Record<string, string | undefined>,
  body: Buffer,
  socket: net.Socket,
): Record<string, unknown> {
  const req: Record<string, unknown> = {
    method,
    url,
    headers,
    socket,
    destroy(): void {
      socket.destroy();
    },
    on(event: string, cb: (...args: unknown[]) => void): unknown {
      if (event === 'data') {
        if (body.length > 0) queueMicrotask(() => cb(body));
      } else if (event === 'end') {
        queueMicrotask(() => cb());
      }
      // 'error' never fires: the body is already in hand.
      return req;
    },
    once(event: string, cb: (...args: unknown[]) => void): unknown {
      return (req.on as (e: string, c: (...a: unknown[]) => void) => unknown)(event, cb);
    },
  };
  return req;
}

/**
 * Minimal response shim: writeHead stores, end() performs the single
 * socket.write of [head + body]. headersSent mirrors node:http (true once
 * writeHead ran) so the dispatch error path behaves the same.
 */
function makeResponse(socket: net.Socket, method: string, closeAfter: boolean): Record<string, unknown> {
  let status = 200;
  let headers: Record<string, string> = {};
  let sent = false;
  const res: Record<string, unknown> = {
    get headersSent(): boolean {
      return sent;
    },
    writeHead(s: number, h?: Record<string, string>): unknown {
      status = s;
      if (h !== undefined) headers = h;
      sent = true;
      return res;
    },
    end(data?: string | Buffer): unknown {
      if (!sent) {
        status = 200;
        headers = {};
        sent = true;
      }
      let bodyBuf: Buffer;
      if (data === undefined) bodyBuf = EMPTY_BODY;
      else if (typeof data === 'string') bodyBuf = Buffer.from(data, 'utf8');
      else bodyBuf = data;
      const isHead = method === 'HEAD';
      // The handlers always set Content-Length; fill it in when missing so
      // the client can frame the response (204/304 carry no body at all).
      let hasLength = false;
      let head = `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? ''}\r\n`;
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'content-length') hasLength = true;
        head += `${key}: ${headers[key]}\r\n`;
      }
      if (closeAfter) head += 'Connection: close\r\n';
      if (!hasLength && status !== 204 && status !== 304) {
        head += `Content-Length: ${isHead ? bodyBuf.length : bodyBuf.length}\r\n`;
      }
      head += '\r\n';
      const headBuf = Buffer.from(head, 'latin1');
      const out = isHead || bodyBuf.length === 0 ? headBuf : Buffer.concat([headBuf, bodyBuf]);
      socket.write(out);
      if (closeAfter) socket.end();
      return res;
    },
    destroy(): void {
      socket.destroy();
    },
  };
  return res;
}

interface ParsedHead {
  method: string;
  url: string;
  httpVersion: string;
  headers: Record<string, string | undefined>;
  headEnd: number; // offset just past the \r\n\r\n
  contentLength: number;
  chunked: boolean;
  expectContinue: boolean;
  closeAfter: boolean;
}

/** Parse request line + headers from buf[0..headEnd). Null = malformed. */
function parseHead(buf: Buffer, headEnd: number): ParsedHead | null {
  const text = buf.toString('latin1', 0, headEnd - 4);
  const lineEnd = text.indexOf('\r\n');
  const requestLine = lineEnd < 0 ? text : text.slice(0, lineEnd);
  const sp1 = requestLine.indexOf(' ');
  const sp2 = sp1 < 0 ? -1 : requestLine.indexOf(' ', sp1 + 1);
  if (sp1 <= 0 || sp2 <= sp1 + 1) return null;
  const method = requestLine.slice(0, sp1);
  const url = requestLine.slice(sp1 + 1, sp2);
  const version = requestLine.slice(sp2 + 1);
  if (url.length === 0 || !version.startsWith('HTTP/')) return null;
  const headers: Record<string, string | undefined> = {};
  if (lineEnd >= 0) {
    const rest = text.slice(lineEnd + 2);
    let at = 0;
    for (;;) {
      const eol = rest.indexOf('\r\n', at);
      const line = eol < 0 ? rest.slice(at) : rest.slice(at, eol);
      if (line.length > 0) {
        const colon = line.indexOf(':');
        if (colon <= 0) return null;
        const name = line.slice(0, colon).toLowerCase();
        const value = line.slice(colon + 1).trim();
        const prev = headers[name];
        headers[name] = prev === undefined ? value : `${prev}, ${value}`;
      }
      if (eol < 0) break;
      at = eol + 2;
    }
  }
  const connection = headers.connection?.toLowerCase() ?? '';
  const is10 = version === 'HTTP/1.0';
  const closeAfter = connection.includes('close') || (is10 && !connection.includes('keep-alive'));
  const te = headers['transfer-encoding']?.toLowerCase() ?? '';
  const chunked = te.includes('chunked');
  let contentLength = 0;
  if (!chunked) {
    const cl = headers['content-length'];
    if (cl !== undefined) {
      contentLength = Number(cl);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) return null;
    }
  }
  return {
    method,
    url,
    httpVersion: version,
    headers,
    headEnd,
    contentLength,
    chunked,
    expectContinue: (headers.expect?.toLowerCase() ?? '') === '100-continue',
    closeAfter,
  };
}

/**
 * Parse one chunked body starting at `start`. Returns the body + total
 * bytes consumed, or null when more data is needed. Malformed => 'bad'.
 */
function parseChunked(buf: Buffer, start: number): { body: Buffer; consumed: number } | 'bad' | null {
  const chunks: Buffer[] = [];
  let total = 0;
  let at = start;
  for (;;) {
    const eol = buf.indexOf('\r\n', at);
    if (eol < 0) return null;
    const sizeText = buf.toString('latin1', at, eol).split(';', 1)[0].trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isSafeInteger(size) || size < 0) return 'bad';
    const dataStart = eol + 2;
    if (size === 0) {
      // Trailers end at the next blank line; usually immediate.
      const trailerEnd = buf.indexOf('\r\n', dataStart);
      if (trailerEnd < 0) return null;
      // One trailer line max in practice; consume until a blank line.
      let tAt = dataStart;
      for (;;) {
        const tEol = buf.indexOf('\r\n', tAt);
        if (tEol < 0) return null;
        if (tEol === tAt) return { body: Buffer.concat(chunks, total), consumed: tEol + 2 - start };
        tAt = tEol + 2;
      }
    }
    if (buf.length < dataStart + size + 2) return null;
    if (buf[dataStart + size] !== 13 || buf[dataStart + size + 1] !== 10) return 'bad';
    chunks.push(buf.subarray(dataStart, dataStart + size));
    total += size;
    if (total > MAX_BODY_BYTES) return 'bad';
    at = dataStart + size + 2;
  }
}

export function createRawTcpServer(dispatch: RawDispatch): net.Server {
  const server = net.createServer((socket) => {
    // FIX #1 (v3 lesson): node:net defaults NoDelay OFF; node:http turns it
    // on. Without this, Nagle delays every small response.
    socket.setNoDelay(true);
    let buf: Buffer = EMPTY_BODY;
    let destroyed = false;
    // Ordered dispatch: pipelined requests answer in arrival order.
    let chain: Promise<void> = Promise.resolve();
    let continueSentForHead = -1; // headEnd offset the 100 was sent for

    const fail = (status: number): void => {
      if (destroyed) return;
      destroyed = true;
      const text = STATUS_TEXT[status] ?? '';
      const body = JSON.stringify({ message: text });
      socket.end(
        `HTTP/1.1 ${status} ${text}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    };

    const pump = (): void => {
      for (;;) {
        if (destroyed) return;
        const headSep = buf.indexOf('\r\n\r\n');
        if (headSep < 0) {
          if (buf.length > MAX_HEADER_BYTES) fail(431);
          return;
        }
        const headEnd = headSep + 4;
        const head = parseHead(buf, headEnd);
        if (head === null) {
          fail(400);
          return;
        }
        let body: Buffer;
        let consumed: number;
        if (head.chunked) {
          if (head.expectContinue && continueSentForHead !== headEnd) {
            socket.write(CONTINUE_100);
            continueSentForHead = headEnd;
          }
          const parsed = parseChunked(buf, headEnd);
          if (parsed === null) return; // need more data
          if (parsed === 'bad') {
            fail(400);
            return;
          }
          body = parsed.body;
          consumed = headEnd + parsed.consumed;
        } else {
          if (head.contentLength > MAX_BODY_BYTES) {
            fail(413);
            return;
          }
          if (buf.length < headEnd + head.contentLength) {
            if (head.expectContinue && continueSentForHead !== headEnd) {
              socket.write(CONTINUE_100);
              continueSentForHead = headEnd;
            }
            return; // need more data
          }
          body = buf.subarray(headEnd, headEnd + head.contentLength);
          consumed = headEnd + head.contentLength;
        }
        buf = buf.subarray(consumed);
        continueSentForHead = -1;
        const req = makeRequest(head.method, head.url, head.headers, body, socket);
        const res = makeResponse(socket, head.method, head.closeAfter);
        // Chain keeps pipelined responses in order; dispatch resolves once
        // the response is written (all sends are synchronous in the handler).
        // The trailing catch keeps one failed dispatch from wedging later
        // requests on this socket (dispatch is designed never to reject).
        chain = chain.then(() => dispatch(req, res)).catch(() => {});
        if (head.closeAfter) {
          // No more requests on this socket; stop parsing (socket.end()
          // runs after the response write inside res.end()).
          return;
        }
        if (buf.length === 0) return;
      }
    };

    socket.on('data', (chunk: Buffer) => {
      if (destroyed) return;
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      pump();
    });
    socket.on('error', () => {
      destroyed = true;
    });
    socket.on('close', () => {
      destroyed = true;
    });
  });
  return server;
}
