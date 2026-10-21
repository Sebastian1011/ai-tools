import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import inventory from '../src/inventory.json' with { type: 'json' };
import { createHttpServer } from '../src/http.mjs';

const tools = new Map(inventory.tools.map(tool => [tool.name, tool]));
const values = {
  owner: 'o', repo: 'r', issue_number: 7, pullNumber: 8, comment_id: 9, commentId: 9,
  threadID: '12', notificationID: '12', method: 'create', action: 'watch',
  name: 'demo', title: 'Title', body: 'Body', filename: 'note.txt', content: 'hello',
  gist_id: 'gist1', level: 'repository', enforcement: 'active', rules: [],
  properties: [{ property_name: 'tier', value: 'gold' }], sub_issue_id: 11,
  project_number: 3, owner_type: 'org', path: 'docs/a.txt', branch: 'main',
  message: 'Commit', files: [{ path: 'a.txt', content: 'A' }], head: 'feature', base: 'main',
  item_id: 22, view_id: 'view-node', item_owner: 'o', item_repo: 'r', issue_number: 7,
  updated_field: { id: 5, value: 'option-id' }, item_type: 'issue',
  rationale: 'Reason', confidence: 'HIGH', is_suggestion: false, pull_request_number: 8,
  iteration_duration: 14, start_date: '2026-01-01', field_name: 'Sprint',
  layout: 'table', status: 'ON_TRACK', subjectType: 'LINE',
};
function args(name, extra = {}) {
  const schema = tools.get(name).inputSchema;
  return { ...Object.fromEntries((schema.required || []).map(key => [key, values[key] ?? (schema.properties[key]?.type === 'array' ? [] : 'x')])), ...extra };
}
const R = (method, path, body, headers) => ({ method, path, body, headers });
const G = (operation, variables, headers) => ({ method: 'POST', path: '/graphql', operation, variables, headers });
const Q = (fragment, variables) => ({ method: 'POST', path: '/graphql', queryIncludes: fragment, variables });
const base = '/repos/o/r';

const cases = [];
function check(name, extra, expected) { cases.push({ name, extra, expected }); }
for (const [method, suffix, verb] of [
  ['rerun_workflow_run', 'rerun', 'POST'], ['rerun_failed_jobs', 'rerun-failed-jobs', 'POST'],
  ['cancel_workflow_run', 'cancel', 'POST'], ['delete_workflow_run_logs', 'logs', 'DELETE'],
]) check('actions_run_trigger', { method, run_id: 18 }, [R(verb, `${base}/actions/runs/18/${suffix}`, verb === 'POST' ? {} : undefined)]);
check('actions_run_trigger', { method: 'run_workflow', workflow_id: '17', ref: 'main', inputs: { region: 'test' } }, [R('POST', `${base}/actions/workflows/17/dispatches`, { ref: 'main', inputs: { region: 'test' } })]);
check('request_copilot_review', {}, [R('POST', `${base}/pulls/8/requested_reviewers`, { reviewers: ['copilot-pull-request-reviewer[bot]'] })]);
check('create_gist', {}, [R('POST', '/gists', { public: false, files: { 'note.txt': { content: 'hello' } } })]);
check('update_gist', {}, [R('PATCH', '/gists/gist1', { files: { 'note.txt': { content: 'hello' } } })]);
for (const [level, ownerFields, path] of [
  ['repository', { owner: 'o', repo: 'r' }, `${base}/rulesets`],
  ['organization', { org: 'myorg' }, '/orgs/myorg/rulesets'],
  ['enterprise', { enterprise: 'ent' }, '/enterprises/ent/rulesets'],
]) check('create_repository_ruleset', { level, ...ownerFields }, [R('POST', path, { name: 'demo', enforcement: 'active', target: 'branch', rules: [] })]);
for (const [level, ownerFields, method, path, body] of [
  ['repository', { owner: 'o', repo: 'r' }, 'PATCH', `${base}/properties/values`, { properties: values.properties }],
  ['organization', { org: 'myorg' }, 'PATCH', '/orgs/myorg/properties/schema', { properties: [{ property_name: 'tier', value_type: 'string' }] }],
  ['enterprise', { enterprise: 'ent' }, 'PATCH', '/enterprises/ent/properties/schema', { properties: [{ property_name: 'tier', value_type: 'string' }] }],
]) check('custom_properties_write', { level, ...ownerFields, ...(level === 'repository' ? {} : { properties: [{ property_name: 'tier', value_type: 'string' }] }) }, level === 'repository' ? [R(method, path, body)] : [R('GET', path), R(method, path, body)]);
check('add_issue_comment', { body: 'Hello' }, [R('POST', `${base}/issues/7/comments`, { body: 'Hello' })]);
check('add_issue_comment', { reaction: '+1', comment_id: 9 }, [R('POST', `${base}/issues/comments/9/reactions`, { content: '+1' })]);
check('issue_write', { method: 'create', title: 'New', body: 'Body', labels: ['bug'] }, [R('POST', `${base}/issues`, { title: 'New', body: 'Body', labels: ['bug'] })]);
check('issue_write', { method: 'update', issue_number: 7, title: 'Updated', state: 'closed' }, [R('PATCH', `${base}/issues/7`, { title: 'Updated', state: 'closed' })]);
check('sub_issue_write', { method: 'add', replace_parent: true }, [R('POST', `${base}/issues/7/sub_issues`, { sub_issue_id: 11, replace_parent: true })]);
check('sub_issue_write', { method: 'remove' }, [R('DELETE', `${base}/issues/7/sub_issues/11`)]);
check('sub_issue_write', { method: 'reprioritize', after_id: 10 }, [R('PATCH', `${base}/issues/7/sub_issues/priority`, { sub_issue_id: 11, after_id: 10 })]);
check('update_issue_comment', {}, [R('PATCH', `${base}/issues/comments/9`, { body: 'Body' })]);
for (const [method, verb, path, body] of [
  ['create', 'POST', `${base}/labels`, { name: 'demo', color: 'abcdef' }],
  ['update', 'PATCH', `${base}/labels/demo`, { new_name: 'new', color: 'abcdef' }],
  ['delete', 'DELETE', `${base}/labels/demo`],
]) check('label_write', { method, color: 'abcdef', ...(method === 'update' ? { new_name: 'new' } : {}) }, [R(verb, path, body)]);
check('dismiss_notification', { state: 'done' }, [R('PATCH', '/notifications/threads/12', { state: 'done' })]);
for (const action of ['ignore', 'watch', 'delete']) check('manage_notification_subscription', { action }, [R(action === 'delete' ? 'DELETE' : 'PUT', '/notifications/threads/12/subscription', action === 'delete' ? undefined : { ignored: action === 'ignore' })]);
for (const action of ['ignore', 'watch', 'delete']) check('manage_repository_notification_subscription', { action }, [R(action === 'delete' ? 'DELETE' : 'PUT', `${base}/subscription`, action === 'delete' ? undefined : { subscribed: action === 'watch', ignored: action === 'ignore' })]);
check('mark_all_notifications_read', { lastReadAt: '2026-01-01T00:00:00Z' }, [R('PUT', '/notifications', { last_read_at: '2026-01-01T00:00:00Z' })]);
check('add_comment_to_pending_review', { line: 5, side: 'RIGHT' }, [R('GET', `${base}/pulls/8/reviews`), R('POST', `${base}/pulls/8/reviews/44/comments`, { body: 'Body', path: 'docs/a.txt', line: 5, side: 'RIGHT', subject_type: 'LINE' })]);
check('add_reply_to_pull_request_comment', { pullNumber: 8, body: 'Reply' }, [R('POST', `${base}/pulls/8/comments/9/replies`, { body: 'Reply' })]);
check('add_reply_to_pull_request_comment', { reaction: 'heart' }, [R('POST', `${base}/pulls/comments/9/reactions`, { content: 'heart' })]);
check('create_pull_request', { body: 'Body', draft: true, reviewers: ['alice'] }, [R('POST', `${base}/pulls`, { title: 'Title', head: 'feature', base: 'main', body: 'Body', draft: true }), R('POST', `${base}/pulls/8/requested_reviewers`, { reviewers: ['alice'] })]);
check('merge_pull_request', { merge_method: 'squash', expectedHeadSha: 'head-sha' }, [R('PUT', `${base}/pulls/8/merge`, { merge_method: 'squash', sha: 'head-sha' })]);
check('pull_request_review_write', { method: 'create', body: 'Review', event: 'COMMENT', commitID: 'head-sha' }, [R('POST', `${base}/pulls/8/reviews`, { body: 'Review', event: 'COMMENT', commit_id: 'head-sha' })]);
check('pull_request_review_write', { method: 'submit_pending', body: 'Done', event: 'APPROVE' }, [R('GET', `${base}/pulls/8/reviews`), R('POST', `${base}/pulls/8/reviews/44/events`, { body: 'Done', event: 'APPROVE' })]);
check('pull_request_review_write', { method: 'delete_pending' }, [R('GET', `${base}/pulls/8/reviews`), R('DELETE', `${base}/pulls/8/reviews/44`)]);
check('pull_request_review_write', { method: 'resolve_thread', threadId: 'thread-node' }, [G('resolveReviewThread', { input: { threadId: 'thread-node' } })]);
check('pull_request_review_write', { method: 'unresolve_thread', threadId: 'thread-node' }, [G('unresolveReviewThread', { input: { threadId: 'thread-node' } })]);
check('update_pull_request', { title: 'Updated', reviewers: ['bob'], draft: true }, [R('PATCH', `${base}/pulls/8`, { title: 'Updated' }), R('POST', `${base}/pulls/8/requested_reviewers`, { reviewers: ['bob'] }), G('convertPullRequestToDraft', { input: { pullRequestId: 'pr-node' } })]);
check('update_pull_request_branch', { expectedHeadSha: 'head-sha' }, [R('PUT', `${base}/pulls/8/update-branch`, { expected_head_sha: 'head-sha' })]);
check('create_branch', { branch: 'new', from_branch: 'main' }, [R('GET', `${base}/git/ref/heads/main`), R('POST', `${base}/git/refs`, { ref: 'refs/heads/new', sha: 'head-sha' })]);
check('create_or_update_file', { path: 'docs/a.txt', content: 'hello', sha: 'old-sha' }, [R('PUT', `${base}/contents/docs/a.txt`, { message: 'Commit', content: 'aGVsbG8=', branch: 'main', sha: 'old-sha' })]);
check('create_repository', {}, [R('POST', '/user/repos', { name: 'demo', private: true })]);
check('create_repository', { organization: 'myorg', private: false }, [R('POST', '/orgs/myorg/repos', { name: 'demo', private: false })]);
check('delete_file', {}, [R('GET', `${base}/contents/docs/a.txt?ref=main`), R('DELETE', `${base}/contents/docs/a.txt`, { message: 'Commit', branch: 'main', sha: 'old-sha' })]);
check('delete_repository', {}, [R('DELETE', base)]);
check('fork_repository', { organization: 'myorg' }, [R('POST', `${base}/forks`, { organization: 'myorg' })]);
check('push_files', {}, [R('GET', `${base}/git/ref/heads/main`), R('GET', `${base}/git/commits/head-sha`), R('POST', `${base}/git/trees`, { base_tree: 'tree-sha', tree: [{ path: 'a.txt', mode: '100644', type: 'blob', content: 'A' }] }), R('POST', `${base}/git/commits`, { message: 'Commit', tree: 'tree-new', parents: ['head-sha'] }), R('PATCH', `${base}/git/ref/heads/main`, { sha: 'commit-new', force: false })]);
check('star_repository', {}, [R('PUT', '/user/starred/o/r')]);
check('unstar_repository', {}, [R('DELETE', '/user/starred/o/r')]);
const agent = { customAgent: '', customInstructions: '', targetRepositoryId: 'repo-node' };
const copilotLookups = [Q('suggestedActors', { owner: 'o', repo: 'r', after: null }), Q('issue(number:', { owner: 'o', repo: 'r', number: 7 })];
check('assign_copilot_to_issue', {}, [...copilotLookups, G('updateIssue', { input: { id: 'issue-node', assigneeIds: ['bot-node'], agentAssignment: agent } }, ['GraphQL-Features: issues_copilot_assignment_api_support'])]);
check('assign_copilot_to_issue_with_intent', {}, [...copilotLookups, G('updateIssue', { input: { id: 'issue-node', assignees: [{ actorId: 'bot-node', rationale: 'Reason', confidence: 'HIGH', suggest: false }], agentAssignment: agent } }, ['GraphQL-Features: issues_copilot_assignment_api_support'])]);
const discussion = { owner: 'o', repo: 'r', discussionNumber: 4, body: 'Body', commentNodeID: 'comment-node' };
check('discussion_comment_write', { ...discussion, method: 'add' }, [Q('discussion(number:', { owner: 'o', repo: 'r', number: 4 }), G('addDiscussionComment', { input: { discussionId: 'disc-node', body: 'Body' } })]);
check('discussion_comment_write', { ...discussion, method: 'reply' }, [Q('discussion(number:', { owner: 'o', repo: 'r', number: 4 }), G('addDiscussionComment', { input: { discussionId: 'disc-node', body: 'Body', replyToId: 'comment-node' } })]);
check('discussion_comment_write', { ...discussion, method: 'update' }, [G('updateDiscussionComment', { input: { commentId: 'comment-node', body: 'Body' } })]);
check('discussion_comment_write', { ...discussion, method: 'delete' }, [G('deleteDiscussionComment', { input: { id: 'comment-node' } })]);
check('discussion_comment_write', { ...discussion, method: 'mark_answer' }, [G('markDiscussionCommentAsAnswer', { input: { id: 'comment-node' } })]);
check('discussion_comment_write', { ...discussion, method: 'unmark_answer' }, [G('unmarkDiscussionCommentAsAnswer', { input: { id: 'comment-node' } })]);
const project = { owner: 'o', owner_type: 'org', project_number: 3 };
const projectLookup = Q('projectV2(number:', { owner: 'o', number: 3 });
const projectPath = '/orgs/o/projectsV2/3';
const projectHeader = ['X-GitHub-Api-Version: 2026-03-10'];
check('projects_write', { ...project, method: 'create_project', title: 'Title' }, [Q('organization(login:', { owner: 'o' }), G('createProjectV2', { input: { ownerId: 'owner-node', title: 'Title' } })]);
check('projects_write', { ...project, method: 'add_project_item', item_type: 'issue', item_owner: 'o', item_repo: 'r', issue_number: 7 }, [projectLookup, Q('issue(number:', { owner: 'o', repo: 'r', number: 7 }), G('addProjectV2ItemById', { input: { projectId: 'project-node', contentId: 'issue-node' } })]);
check('projects_write', { ...project, method: 'update_project_item', item_id: 22, updated_field: values.updated_field }, [R('PATCH', `${projectPath}/items/22`, { fields: [values.updated_field] }, projectHeader)]);
check('projects_write', { ...project, method: 'update_project_items', items: [{ item_id: 22 }, { item_id: 23 }], updated_field: values.updated_field }, [R('PATCH', `${projectPath}/items/22`, { fields: [values.updated_field] }, projectHeader), R('PATCH', `${projectPath}/items/23`, { fields: [values.updated_field] }, projectHeader)]);
check('projects_write', { ...project, method: 'delete_project_item', item_id: 22 }, [R('DELETE', `${projectPath}/items/22`, undefined, projectHeader)]);
check('projects_write', { ...project, method: 'create_project_status_update', body: 'Body', status: 'ON_TRACK', start_date: '2026-01-01' }, [projectLookup, G('createProjectV2StatusUpdate', { input: { projectId: 'project-node', body: 'Body', status: 'ON_TRACK', startDate: '2026-01-01' } })]);
check('projects_write', { ...project, method: 'create_project_view', name: 'demo', layout: 'table', filter: 'is:open' }, [projectLookup, G('createProjectV2View', { input: { projectId: 'project-node', name: 'demo', layout: 'TABLE_LAYOUT' } }), G('updateProjectV2View', { input: { viewId: 'view-node', filter: 'is:open' } })]);
check('projects_write', { ...project, method: 'update_project_view', view_id: 'view-node', name: 'Updated', layout: 'board' }, [G('updateProjectV2View', { input: { viewId: 'view-node', name: 'Updated', layout: 'BOARD_LAYOUT' } })]);
check('projects_write', { ...project, method: 'delete_project_view', view_id: 'view-node' }, [G('deleteProjectV2View', { input: { viewId: 'view-node' } })]);
check('projects_write', { ...project, method: 'create_iteration_field', field_name: 'Sprint', iteration_duration: 14, start_date: '2026-01-01' }, [projectLookup, G('createProjectV2Field', { input: { projectId: 'project-node', dataType: 'ITERATION', name: 'Sprint' } }), G('updateProjectV2Field', { input: { fieldId: 'field-node', iterationConfiguration: { duration: 14, startDate: '2026-01-01', iterations: [] } } })]);

// The fake program records every argv/body pair. It never invokes the real gh binary.
const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.GH_MOCK_LOG, JSON.stringify({args,input})+'\\n');
const path = args[1];
let output = {number:8,node_id:'pr-node',draft:false,sha:'commit-new',default_branch:'main',object:{sha:'head-sha'},tree:{sha:'tree-sha'}};
if(path === '/graphql') {
 const body = JSON.parse(input);
 const q = body.query;
 const op = q.match(/\\{(\\w+)\\(input:/)?.[1];
 const mutationValue = {issue:{id:'issue-node',number:7,url:'https://example.test/issue/7'},pullRequest:{id:'pr-node',isDraft:true},comment:{id:'comment-node',body:'Body',url:'https://example.test/comment'},discussion:{id:'disc-node',number:7},thread:{id:'thread-node',isResolved:true},projectV2:{id:'project-node',number:3,title:'Title'},item:{id:'item-node',fullDatabaseId:22},statusUpdate:{id:'status-node'},projectV2View:{id:'view-node'},projectV2Field:{id:'field-node'}};
 output = {data:op?{[op]:mutationValue}:{repository:{id:'repo-node',issue:{id:'issue-node',assignees:{nodes:[]}},suggestedActors:{nodes:[{id:'bot-node',login:'copilot-swe-agent'}],pageInfo:{hasNextPage:false}},discussion:{id:'disc-node'},pullRequest:{id:'pr-node'}},organization:{id:'owner-node',projectV2:{id:'project-node',number:3,title:'Title'}},user:{id:'owner-node',projectV2:{id:'project-node',number:3,title:'Title'}},node:{id:'node-id',fullDatabaseId:22}}};
} else if(path?.endsWith('/reviews') && args.includes('GET')) output = [{id:44,state:'PENDING'}];
else if(path?.includes('/contents/') && args.includes('GET')) output = {sha:'old-sha'};
else if(path?.endsWith('/properties/schema') && args.includes('GET')) output = [];
else if(path?.includes('/git/trees') && args.includes('POST')) output = {sha:'tree-new'};
else if(path?.includes('/git/ref/heads/') && args.includes('GET')) output = {object:{sha:'head-sha'}};
else if(path?.includes('/git/commits/') && args.includes('GET')) output = {tree:{sha:'tree-sha'}};
console.log(JSON.stringify(output));
`;

function parseCall(line) {
  const { args, input } = JSON.parse(line);
  assert.equal(args[0], 'api');
  const method = args[args.indexOf('--method') + 1];
  const headers = args.flatMap((item, i) => item === '-H' ? [args[i + 1]] : []);
  return { argv: args, method, path: args[1], body: input ? JSON.parse(input) : undefined, headers };
}
function assertCall(actual, expected) {
  assert.deepEqual(actual.argv, ['api', expected.path, '--method', expected.method, ...(expected.headers || []).flatMap(header => ['-H', header]), ...(expected.path === '/graphql' || expected.body !== undefined ? ['--input', '-'] : [])]);
  assert.equal(actual.method, expected.method);
  assert.equal(actual.path, expected.path);
  if (expected.path === '/graphql') {
    assert.ok(actual.body.query.includes(expected.operation ? `${expected.operation}(input:` : expected.queryIncludes), actual.body.query);
    assert.deepEqual(actual.body.variables, expected.variables);
  } else assert.deepEqual(actual.body, expected.body);
  if (expected.headers) assert.deepEqual(actual.headers, expected.headers);
  else assert.deepEqual(actual.headers, []);
}

test('every write tool branch maps HTTP tools/call to the expected fake gh API command', async t => {
  const writeTools = inventory.tools.filter(tool => tool.annotations?.readOnlyHint !== true);
  for (const tool of writeTools) {
    const variants = tool.inputSchema.properties?.method?.enum || tool.inputSchema.properties?.action?.enum || (tool.name === 'sub_issue_write' ? ['add', 'remove', 'reprioritize'] : [null]);
    const key = tool.inputSchema.properties?.action?.enum ? 'action' : 'method';
    for (const variant of variants) assert.ok(cases.some(item => item.name === tool.name && (variant === null || item.extra[key] === variant)), `Missing write route case: ${tool.name}.${variant}`);
  }
  t.diagnostic(`${writeTools.length} write tools, ${cases.length} HTTP route cases`);
  const dir = await mkdtemp(join(tmpdir(), 'gh-mcp-write-routing-'));
  const binary = join(dir, 'gh-fake');
  const log = join(dir, 'calls.jsonl');
  await writeFile(binary, fakeGh, { mode: 0o755 });
  const previous = { GH_BINARY: process.env.GH_BINARY, GH_MOCK_LOG: process.env.GH_MOCK_LOG, GH_TOKEN_FILE: process.env.GH_TOKEN_FILE, GH_TOKEN: process.env.GH_TOKEN };
  process.env.GH_BINARY = binary;
  process.env.GH_MOCK_LOG = log;
  delete process.env.GH_TOKEN_FILE;
  delete process.env.GH_TOKEN;
  const server = createHttpServer({ GITHUB_TOOLSETS: 'all' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    for (const item of cases) {
      await writeFile(log, '');
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: item.name, arguments: args(item.name, item.extra) } }) });
      assert.equal(response.status, 200, item.name);
      const reply = await response.json();
      assert.ok(reply.result && !reply.result.isError, `${item.name} ${JSON.stringify(item.extra)}: ${JSON.stringify(reply)}`);
      const calls = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(parseCall);
      assert.equal(calls.length, item.expected.length, `${item.name} ${JSON.stringify(item.extra)}`);
      for (let i = 0; i < calls.length; i++) {
        try { assertCall(calls[i], item.expected[i]); }
        catch (error) { error.message = `${item.name} ${JSON.stringify(item.extra)} call ${i + 1}: ${error.message}`; throw error; }
      }
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(dir, { recursive: true, force: true });
  }
});
