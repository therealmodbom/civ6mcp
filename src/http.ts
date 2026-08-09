#!/usr/bin/env node
// Streamable HTTP entry point. Binds loopback only and has no authentication of its
// own — put a proxy in front of it (for example `tailscale serve`) rather than
// changing HOST, and name that proxy's hostname in MCP_ALLOWED_HOSTS.
//
// Env: PORT (default 8000), MCP_ALLOWED_HOSTS (comma-separated, adds to the defaults).
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { server } from './index.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8000);
const PATH = '/mcp';

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid PORT: ${JSON.stringify(process.env.PORT)}`);
  process.exit(1);
}

const allowedHosts = [
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  ...(process.env.MCP_ALLOWED_HOSTS ?? '').split(',').map((host) => host.trim()).filter(Boolean),
];

// The SDK only checks Origin when allowedOrigins is set, and skips the check when a
// request carries none — so this constrains browsers without affecting other clients.
const allowedOrigins = allowedHosts.flatMap((host) => [`http://${host}`, `https://${host}`]);

// One shared session: this reuses the module-level `server`, which can only be
// connected to a single transport. That serves one client at a time — a second
// client's initialize is rejected while the first session is open.
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
  enableDnsRebindingProtection: true,
  allowedHosts,
  allowedOrigins,
});
await server.connect(transport);

createServer((req, res) => {
  if (new URL(req.url ?? '/', `http://${HOST}`).pathname !== PATH) {
    res.writeHead(404).end();
    return;
  }
  transport.handleRequest(req, res).catch((error) => {
    console.error('Request failed:', error);
    if (!res.headersSent) res.writeHead(500).end();
  });
}).listen(PORT, HOST, () => {
  console.error(`Civ6 MCP Server running on http://${HOST}:${PORT}${PATH}`);
});
