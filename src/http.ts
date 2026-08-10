#!/usr/bin/env node
// Streamable HTTP entry point. Binds loopback only and has no authentication of its
// own — put a proxy in front of it (for example `tailscale serve`) rather than
// changing HOST, and name that proxy's hostname in MCP_ALLOWED_HOSTS.
//
// Env: PORT (default 8000), MCP_ALLOWED_HOSTS (comma-separated, adds to the defaults),
// MCP_ALLOWED_ORIGINS (comma-separated; unset leaves the Origin check off),
// MCP_SESSION_IDLE_MS (default 30 min; doubles as the TCP keepalive idle delay).
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './index.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8000);
const PATH = '/mcp';

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid PORT: ${JSON.stringify(process.env.PORT)}`);
  process.exit(1);
}

// A client that crashes or loses the network never sends DELETE, and the SDK only
// closes a transport from its delete handler — so without an idle sweep every lost
// client leaks a Server plus transport for the lifetime of the process.
const SESSION_IDLE_MS = Number(process.env.MCP_SESSION_IDLE_MS ?? 30 * 60_000);
if (!Number.isFinite(SESSION_IDLE_MS) || SESSION_IDLE_MS < 1_000) {
  // NaN would make the sweep spin and expire nothing, quietly restoring the leak
  console.error(`Invalid MCP_SESSION_IDLE_MS: ${JSON.stringify(process.env.MCP_SESSION_IDLE_MS)} (minimum 1000)`);
  process.exit(1);
}
const SWEEP_INTERVAL_MS = Math.min(60_000, Math.max(1_000, SESSION_IDLE_MS / 2));

const allowedHosts = [
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  ...(process.env.MCP_ALLOWED_HOSTS ?? '').split(',').map(h => h.trim()).filter(Boolean),
];

// Origins are the calling *pages*, not this server's own addresses — deriving them
// from allowedHosts rejected every real browser client (an MCP Inspector on
// localhost:6274 got the same 403 as an attacker) while allowing none. Opt-in via
// MCP_ALLOWED_ORIGINS; unset means the SDK skips the Origin check, which is the
// honest default for a loopback server that sends no CORS headers anyway.
const allowedOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

interface Session {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
  /**
   * Requests still in flight, including a standalone SSE stream held open. TCP
   * keepalive bounds how long a peer that has vanished can hold this above zero.
   */
  open: number;
}

// One MCP Server and transport per session — the SDK binds a Server to a single
// transport, so sharing one would serve a single client at a time.
const sessions = new Map<string, Session>();

async function openSession(): Promise<StreamableHTTPServerTransport> {
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableDnsRebindingProtection: true,
    allowedHosts,
    allowedOrigins,
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, { transport, lastSeen: Date.now(), open: 0 });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  await createServer().connect(transport);
  return transport;
}

setInterval(() => {
  const deadline = Date.now() - SESSION_IDLE_MS;
  for (const [sessionId, session] of sessions) {
    // A standalone SSE stream stays open without producing further requests, so
    // idleness is measured only once nothing is in flight for that session.
    if (session.open === 0 && session.lastSeen < deadline) {
      sessions.delete(sessionId);
      void session.transport.close();
      console.error(`Closed idle session ${sessionId}`);
    }
  }
  // Do not keep the process alive just to sweep
}, SWEEP_INTERVAL_MS).unref();

/** Distinct from `undefined` (no body), so a malformed body gets its own answer. */
const MALFORMED = Symbol('malformed-json');

async function readBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return MALFORMED;
  }
}

function jsonRpcError(res: import('node:http').ServerResponse, status: number, code: number, message: string) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(
    JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null })
  );
}

// TCP keepalive is what bounds the in-flight guard. Without it a peer that vanishes
// without FIN holds its request open for the process lifetime: server.timeout is 0 and
// requestTimeout stops applying once the request has been received, so nothing else
// notices. Probes start after SESSION_IDLE_MS of socket silence and the peer's failure
// to answer them closes the socket, which releases the guard. Preferred over an absolute
// session-age cap or treating a held stream as idle: those bound the leak by
// disconnecting healthy long-lived clients too, whereas keepalive separates a dead peer
// from a quiet one. Closing the dead response bumps lastSeen, so the sweep still waits
// a further SESSION_IDLE_MS (+ one sweep interval) after the socket dies — worst case
// ~2×SESSION_IDLE_MS + OS probe budget (macOS: 75s×8) + SWEEP_INTERVAL_MS.
createHttpServer({ keepAlive: true, keepAliveInitialDelay: SESSION_IDLE_MS }, (req, res) => {
  void (async () => {
    try {
      if (new URL(req.url ?? '/', `http://${HOST}`).pathname !== PATH) {
        res.writeHead(404).end();
        return;
      }

      const body = req.method === 'POST' ? await readBody(req) : undefined;
      if (body === MALFORMED) {
        jsonRpcError(res, 400, -32700, 'Parse error: request body is not valid JSON');
        return;
      }

      const headerId = req.headers['mcp-session-id'];
      const sessionId = typeof headerId === 'string' ? headerId : undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId) {
        const session = sessions.get(sessionId);
        // Answer an unknown id as such — including on an initialize, which must not
        // silently mint a second session behind a client that thinks it has one.
        if (!session) {
          jsonRpcError(res, 404, -32001, 'Session not found: re-initialize to obtain a new session id');
          return;
        }
        session.lastSeen = Date.now();
        session.open++;
        res.on('close', () => {
          session.open--;
          session.lastSeen = Date.now();
        });
        transport = session.transport;
      } else if (isInitializeRequest(body)) {
        transport = await openSession();
      } else {
        jsonRpcError(res, 400, -32000, 'Bad Request: no session id, and this is not an initialize request');
        return;
      }

      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error('Request failed:', error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  })();
}).listen(PORT, HOST, () => {
  console.error(`Civ6 MCP Server running on http://${HOST}:${PORT}${PATH}`);
});
