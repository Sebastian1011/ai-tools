import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { handle, selectedTools } from '../src/server.mjs';
import { createHttpServer } from '../src/http.mjs';
import { execute } from '../src/tools.mjs';

test('MCP initializes and lists only executable tools', async () => {
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(list.result.tools.some(tool => tool.name === 'get_file_contents'));
  assert.ok(!list.result.tools.some(tool => tool.name === 'projects_write'));
  assert.equal(new Set(list.result.tools.map(tool => tool.name)).size, list.result.tools.length);
  assert.ok(selectedTools({ GITHUB_TOOLSETS: 'all', GITHUB_READ_ONLY: 'true' }).every(tool => tool.annotations.readOnlyHint));
  assert.deepEqual(selectedTools({ GITHUB_TOOLS: 'get_me' }).map(tool => tool.name), ['get_me']);
  assert.ok(selectedTools({ GITHUB_TOOLSETS: 'all', GITHUB_READ_ONLY: 'YES' }).every(tool => tool.annotations.readOnlyHint));
  assert.ok(!selectedTools({ GITHUB_TOOLSETS: 'all' }, new Set(['repo'])).some(tool => tool.name === 'delete_repository'));
  assert.ok(selectedTools({ GITHUB_TOOLSETS: 'all' }, new Set(['repo', 'delete_repo'])).some(tool => tool.name === 'delete_repository'));
});

test('required arguments and disabled tools are rejected before execution', async () => {
  const missing = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_file_contents', arguments: { owner: 'o' } } });
  assert.match(missing.error.message, /repo/);
  const disabled = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_repository', arguments: { name: 'x' } } }, { GITHUB_READ_ONLY: 'true' });
  assert.match(disabled.error.message, /disabled/);
});

test('GitHub calls pass argv and JSON body without a shell', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gh-mcp-test-'));
  const binary = join(dir, 'gh');
  await writeFile(binary, `#!/usr/bin/env python3
import json,sys
print(json.dumps({'args':sys.argv[1:],'input':sys.stdin.read()}))
`, { mode: 0o755 });
  process.env.GH_BINARY = binary;
  try {
    const filename = 'a;$(touch /tmp/should-not-exist).txt';
    const result = await execute('create_or_update_file', { owner: 'o', repo: 'r', path: filename, branch: 'main', content: 'hello', message: 'test' });
    assert.ok(result.args, JSON.stringify(result));
    assert.equal(result.args[0], 'api');
    assert.match(result.args[1], /^\/repos\/o\/r\/contents\/a%3B%24/);
    assert.equal(result.args[2], '--method');
    assert.equal(JSON.parse(result.input).content, 'aGVsbG8=');
  } finally {
    delete process.env.GH_BINARY;
    await rm(dir, { recursive: true, force: true });
  }
});

test('repository path traversal is rejected', async () => {
  await assert.rejects(() => execute('get_file_contents', { owner: 'o', repo: 'r', path: '../issues' }), /Invalid repository path/);
});

test('issue listing and search honor the advertised scope and filters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gh-mcp-issues-'));
  const binary = join(dir, 'gh');
  await writeFile(binary, `#!/usr/bin/env python3
import json,sys
path=sys.argv[2]
if path.startswith('/repos/'):
 print(json.dumps([{'number':1,'title':'issue'}, {'number':2,'pull_request':{'url':'pr'}}]))
else:
 print(json.dumps({'items':[{'number':1,'title':'issue'}], 'path':path}))
`, { mode: 0o755 });
  process.env.GH_BINARY = binary;
  try {
    const result = await execute('list_issues', { owner: 'o', repo: 'r', state: 'CLOSED', fields: ['number'] });
    assert.deepEqual(result, [{ number: 1 }]);
    const searched = await execute('search_issues', { owner: 'o', repo: 'r', query: 'bug', fields: ['number'] });
    assert.equal(new URL(searched.path, 'https://api.github.com').searchParams.get('q'), 'bug is:issue repo:o/r');
    assert.deepEqual(searched.items, [{ number: 1 }]);
    await assert.rejects(() => execute('list_issues', { owner: 'o', repo: 'r', after: 'cursor' }), /GraphQL/);
  } finally { delete process.env.GH_BINARY; await rm(dir, { recursive: true, force: true }); }
});

test('text file contents return an MCP embedded resource', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gh-mcp-file-'));
  const binary = join(dir, 'gh');
  await writeFile(binary, `#!/usr/bin/env python3
import json,sys
path=sys.argv[2]
if '/contents/' in path: print(json.dumps({'type':'file','name':'README','path':'README','sha':'blob','size':5,'encoding':'base64','content':'aGVsbG8='}))
elif '/commits/' in path: print(json.dumps({'sha':'commit'}))
else: print(json.dumps({'default_branch':'main'}))
`, { mode: 0o755 });
  process.env.GH_BINARY = binary;
  try {
    const result = await handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_file_contents', arguments: { owner: 'o', repo: 'r', path: 'README' } } });
    assert.deepEqual(result.result.content, [
      { type: 'text', text: 'successfully downloaded text file (SHA: blob)' },
      { type: 'resource', resource: { uri: 'repo://o/r/sha/commit/contents/README', mimeType: 'text/plain; charset=utf-8', text: 'hello' } },
    ]);
  } finally { delete process.env.GH_BINARY; await rm(dir, { recursive: true, force: true }); }
});

test('get_me projects the official compact profile shape', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gh-mcp-profile-'));
  const binary = join(dir, 'gh');
  await writeFile(binary, `#!/usr/bin/env python3
import json
print(json.dumps({'login':'octo','id':7,'html_url':'https://github.com/octo','avatar_url':'https://example.test/avatar','name':'Octo','public_repos':2,'node_id':'internal'}))
`, { mode: 0o755 });
  process.env.GH_BINARY = binary;
  try {
    assert.deepEqual(await execute('get_me', {}), { login: 'octo', id: 7, profile_url: 'https://github.com/octo', avatar_url: 'https://example.test/avatar', details: { name: 'Octo', public_repos: 2 } });
  } finally { delete process.env.GH_BINARY; await rm(dir, { recursive: true, force: true }); }
});

test('Docker launcher creates a private persistent token file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gh-mcp-launcher-'));
  const bin = join(dir, 'bin');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(bin);
  await mkdir(join(dir, 'config'));
  await writeFile(join(bin, 'gh'), '#!/bin/sh\nprintf synthetic-test-token\n', { mode: 0o755 });
  await writeFile(join(bin, 'docker'), '#!/bin/sh\ntest -s "$HOST_GH_TOKEN_FILE" || exit 10\nstat -c "%a" "$HOST_GH_TOKEN_FILE"\n', { mode: 0o755 });
  try {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_RUNTIME_DIR: dir, GH_CONFIG_DIR: join(dir, 'config') };
    const one = spawnSync('./scripts/docker-http.sh', { env, encoding: 'utf8' });
    assert.equal(one.status, 0, one.stderr);
    assert.equal(one.stdout.trim(), '600');
    const two = spawnSync('./scripts/docker-http.sh', { env, encoding: 'utf8' });
    assert.equal(two.status, 0, two.stderr);
    assert.equal(two.stdout.trim(), '600');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Streamable HTTP handles initialize, listing, notifications, and origin checks', async () => {
  const server = createHttpServer({ GITHUB_TOOLS: 'get_me' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const send = (message, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(message) });
    const init = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    assert.equal(init.status, 200);
    assert.equal((await init.json()).result.protocolVersion, '2025-03-26');
    const list = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual((await list.json()).result.tools.map(tool => tool.name), ['get_me']);
    assert.equal((await send({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    assert.equal((await send({ jsonrpc: '2.0', id: 3, method: 'ping' }, { origin: 'https://example.com' })).status, 403);
    assert.equal((await fetch(url)).status, 405);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
