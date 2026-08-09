#!/usr/bin/env node
// Streamable HTTP entry point. Binds loopback only and has no authentication of its
// own — put a proxy in front of it (for example `tailscale serve`) rather than
// changing HOST, and name that proxy's hostname in MCP_ALLOWED_HOSTS.
//
// Env: PORT (default 8000), MCP_ALLOWED_HOSTS (comma-separated, adds to the defaults).
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './index.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8000);
const PATH = '/mcp';

const allowedHosts = [
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  ...(process.env.MCP_ALLOWED_HOSTS ?? '').split(',').filter(Boolean),
];

// One MCP Server and transport per session — the SDK binds a Server to a single
// transport, so sharing one would serve a single client at a time.
const sessions = new Map<string, StreamableHTTPServerTransport>();

async function openSession(): Promise<StreamableHTTPServerTransport> {
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableDnsRebindingProtection: true,
    allowedHosts,
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, transport);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  await createServer().connect(transport);
  return transport;
}

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

createHttpServer((req, res) => {
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

      const sessionId = req.headers['mcp-session-id'];
      const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;

      // A session id we do not know, or a first request that is not an initialize,
      // cannot be served — the SDK answers those with the proper JSON-RPC error.
      const transport = existing ?? (isInitializeRequest(body) ? await openSession() : undefined);
      if (!transport) {
        jsonRpcError(res, 400, -32000, 'Bad Request: no valid session id');
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
