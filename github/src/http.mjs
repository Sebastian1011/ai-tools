import http from 'node:http';
import { handle } from './server.mjs';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const maxBody = 1024 * 1024;

export function createHttpServer(env = process.env) {
  return http.createServer(async (req, res) => {
    const hostname = req.headers.host?.split(':')[0];
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
      res.writeHead(403).end('Invalid Host');
      return;
    }
    if (req.headers.origin && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.origin)) {
      res.writeHead(403).end('Invalid Origin');
      return;
    }
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
      return;
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      res.writeHead(415).end();
      return;
    }
    const accept = req.headers.accept || '';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
      res.writeHead(406).end();
      return;
    }
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > maxBody) {
          res.writeHead(413).end();
          return;
        }
      }
      const message = JSON.parse(body);
      if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || Array.isArray(message)) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } }));
        return;
      }
      const reply = await handle(message, env);
      if (!reply) res.writeHead(202).end();
      else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  createHttpServer().listen(port, host, () => console.error(`MCP HTTP listening on ${host}:${port}`));
}
