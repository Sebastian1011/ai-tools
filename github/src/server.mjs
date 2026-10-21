import readline from 'node:readline';
import inventory from './inventory.json' with { type: 'json' };
import { execute, implementedTools } from './tools.mjs';
import { oauthScopes } from './gh.mjs';

const defaults = new Set(['context', 'repos', 'issues', 'pull_requests', 'users', 'copilot']);
const all = inventory.tools;

function csv(value) { return (value || '').split(',').map(s => s.trim()).filter(Boolean); }

export function selectedTools(env = process.env, scopes = null) {
  const requested = csv(env.GITHUB_TOOLSETS);
  const names = new Set(csv(env.GITHUB_TOOLS));
  const sets = new Set(requested.length ? requested : names.size ? [] : ['default']);
  const excluded = new Set(csv(env.GITHUB_EXCLUDE_TOOLS));
  const readOnly = ['true', 't', 'yes', 'y', '1', 'on'].includes(String(env.GITHUB_READ_ONLY || '').trim().toLowerCase());
  for (const name of names) if (!all.some(tool => tool.name === name)) throw new Error(`Unknown tool: ${name}`);
  return all.filter(tool => implementedTools.has(tool.name) &&
    !(tool.name === 'delete_repository' && scopes && !scopes.has('delete_repo')) &&
    (sets.has('all') || (sets.has('default') && defaults.has(tool.toolset)) || sets.has(tool.toolset) || names.has(tool.name)) &&
    !excluded.has(tool.name) &&
    !(readOnly && tool.annotations?.readOnlyHint !== true)
  );
}

let scopeLookup;
async function availableTools(env) {
  if (!env.GH_TOKEN_FILE) return selectedTools(env);
  scopeLookup ||= oauthScopes().catch(() => null);
  return selectedTools(env, await scopeLookup);
}

export function validate(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object');
  for (const key of schema.required || []) if (args[key] === undefined || args[key] === null) throw new Error(`Missing required argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties?.[key];
    if (!property) throw new Error(`Unknown argument: ${key}`);
    if (property.enum && !property.enum.includes(value)) throw new Error(`Invalid ${key}: ${value}`);
    if (value !== null && property.type) {
      const types = Array.isArray(property.type) ? property.type : [property.type];
      const actual = Array.isArray(value) ? 'array' : Number.isFinite(value) ? 'number' : typeof value;
      if (!types.includes(actual) && !(actual === 'number' && types.includes('integer') && Number.isInteger(value))) throw new Error(`Invalid type for ${key}`);
      if (typeof value === 'number' && (value < (property.minimum ?? -Infinity) || value > (property.maximum ?? Infinity))) throw new Error(`Out of range: ${key}`);
    }
  }
}

export async function handle(message, env = process.env) {
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return null;
  const id = message.id;
  if (id === undefined) return null;
  const respond = result => ({ jsonrpc: '2.0', id, result });
  const fail = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
  try {
    switch (message.method) {
      case 'initialize': return respond({ protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'gh-cli-mcp', version: '0.1.0' } });
      case 'ping': return respond({});
      case 'tools/list': return respond({ tools: (await availableTools(env)).map(({ toolset, ...tool }) => tool) });
      case 'tools/call': {
        const name = message.params?.name;
        const tool = (await availableTools(env)).find(item => item.name === name);
        if (!tool) return fail(-32602, `Unknown or disabled tool: ${name}`);
        const args = message.params?.arguments || {};
        validate(tool.inputSchema, args);
        try {
          const result = await execute(name, args);
          if (result?.__mcpResult) return respond(result.__mcpResult);
          return respond({ content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] });
        } catch (error) {
          return respond({ isError: true, content: [{ type: 'text', text: error.message }] });
        }
      }
      default: return fail(-32601, `Method not found: ${message.method}`);
    }
  } catch (error) { return fail(-32602, error.message); }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let reply;
    try { reply = await handle(JSON.parse(line)); }
    catch { reply = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
  }
}
