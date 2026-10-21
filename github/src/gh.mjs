import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const timeoutMs = 60_000;

export function api(method, path, { query, body, accept, headers } = {}) {
  const url = new URL(path, 'https://api.github.com');
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const args = ['api', url.pathname + url.search, '--method', method];
  if (accept) args.push('-H', `Accept: ${accept}`);
  for (const header of headers || []) args.push('-H', header);
  if (body !== undefined) args.push('--input', '-');
  return runGh(args, body === undefined ? undefined : JSON.stringify(body));
}

export function graphql(query, variables = {}, headers = []) {
  return api('POST', '/graphql', { body: { query, variables }, headers });
}

export async function oauthScopes() {
  const response = await runGh(['api', '-i', '/user']);
  const match = String(response).match(/^x-oauth-scopes:\s*([^\r\n]*)/im);
  return match?.[1] ? new Set(match[1].split(',').map(scope => scope.trim()).filter(Boolean)) : null;
}

export async function runGh(args, input) {
  const token = process.env.GH_TOKEN_FILE ? (await readFile(process.env.GH_TOKEN_FILE, 'utf8')).trim() : undefined;
  if (process.env.GH_TOKEN_FILE && !token) throw new Error('Mounted GitHub token file is empty');
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.GH_BINARY || 'gh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(token ? { GH_TOKEN: token } : {}), GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' },
    });
    let stdout = '';
    let stderr = '';
    const limit = 20 * 1024 * 1024;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > limit) child.kill('SIGKILL');
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > limit) child.kill('SIGKILL');
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`gh api failed (exit ${code}): ${redact(stderr.trim()).slice(0, 2000)}`));
      else {
        try { resolve(JSON.parse(stdout)); }
        catch { resolve(stdout); }
      }
    });
    child.stdin.end(input);
  });
}

function redact(message) {
  return message.replace(/(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED]');
}
