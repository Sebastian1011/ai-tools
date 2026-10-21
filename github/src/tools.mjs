import { api, graphql } from './gh.mjs';
import { advanced } from './advanced.mjs';
import { discussionTools } from './discussions.mjs';
import { copilotTools } from './copilot.mjs';
import { projectTools } from './projects.mjs';

const e = value => encodeURIComponent(String(value));
const repo = a => `/repos/${e(a.owner)}/${e(a.repo)}`;
const issue = a => `${repo(a)}/issues/${e(a.issue_number)}`;
const pull = a => `${repo(a)}/pulls/${e(a.pullNumber)}`;
const q = (a, names, mapping = {}) => Object.fromEntries(names.filter(k => a[k] !== undefined).map(k => [mapping[k] || k, a[k]]));
const b = (a, mapping) => Object.fromEntries(Object.entries(mapping).filter(([key]) => a[key] !== undefined).map(([key, name]) => [name, a[key]]));
const call = (method, path, query, body, accept) => api(method, path, { query, body, accept });
const get = (path, query, accept) => call('GET', path, query, undefined, accept);
const post = (path, body) => call('POST', path, undefined, body);
const patch = (path, body) => call('PATCH', path, undefined, body);
const put = (path, body) => call('PUT', path, undefined, body);
const del = (path, body) => call('DELETE', path, undefined, body);
const paging = a => q(a, ['page', 'perPage'], { perPage: 'per_page' });
const search = async (kind, a, suffix = '') => {
  const scope = a.owner && a.repo ? ` repo:${a.owner}/${a.repo}` : '';
  const result = await get(`/search/${kind}`, { q: a.query + suffix + scope, ...q(a, ['sort', 'order', 'page']), per_page: a.perPage });
  if (a.fields && Array.isArray(result.items)) result.items = result.items.map(item => Object.fromEntries(Object.entries(item).filter(([key]) => a.fields.includes(key))));
  return result;
};
const minimalUser = user => ({ login: user.login || '', ...(user.id ? { id: user.id } : {}), ...(user.html_url ? { profile_url: user.html_url } : {}), ...(user.avatar_url ? { avatar_url: user.avatar_url } : {}) });
const minimalPRBranch = branch => branch && ({ ref: branch.ref || '', sha: branch.sha || '', ...(branch.repo ? { repo: { full_name: branch.repo.full_name || '', ...(branch.repo.description ? { description: branch.repo.description } : {}) } } : {}) });
function minimalPR(pr) {
  return {
    number: pr.number || 0, title: pr.title || '', ...(pr.body ? { body: pr.body } : {}),
    state: pr.state || '', draft: pr.draft || false, merged: pr.merged || false,
    ...(pr.mergeable_state ? { mergeable_state: pr.mergeable_state } : {}),
    html_url: pr.html_url || '', ...(pr.user ? { user: minimalUser(pr.user) } : {}),
    ...(pr.labels?.length ? { labels: pr.labels.map(label => label.name) } : {}),
    ...(pr.assignees?.length ? { assignees: pr.assignees.map(user => user.login) } : {}),
    ...(pr.requested_reviewers?.length ? { requested_reviewers: pr.requested_reviewers.map(user => user.login) } : {}),
    ...(pr.merged_by?.login ? { merged_by: pr.merged_by.login } : {}),
    ...(pr.head ? { head: minimalPRBranch(pr.head) } : {}),
    ...(pr.base ? { base: minimalPRBranch(pr.base) } : {}),
    ...Object.fromEntries(['additions', 'deletions', 'changed_files', 'commits', 'comments', 'created_at', 'updated_at', 'closed_at', 'merged_at'].filter(key => pr[key]).map(key => [key, pr[key]])),
    ...(pr.milestone?.title ? { milestone: pr.milestone.title } : {}),
  };
}
async function searchAccounts(a, type) {
  const query = /(?:^|\s)type:/i.test(a.query) ? a.query : `type:${type} ${a.query}`;
  const result = await search('users', { ...a, query });
  return { total_count: result.total_count || 0, incomplete_results: result.incomplete_results || false, items: (result.items || []).map(minimalUser) };
}
async function searchRepositories(a) {
  const result = await search('repositories', a);
  if (a.minimal_output === false) return result;
  return {
    total_count: result.total_count || 0,
    incomplete_results: result.incomplete_results || false,
    items: (result.items || []).map(item => ({
      id: item.id || 0, name: item.name || '', full_name: item.full_name || '',
      ...(item.description ? { description: item.description } : {}),
      html_url: item.html_url || '',
      ...(item.language ? { language: item.language } : {}),
      stargazers_count: item.stargazers_count || 0, forks_count: item.forks_count || 0,
      open_issues_count: item.open_issues_count || 0,
      ...(item.updated_at ? { updated_at: item.updated_at } : {}),
      ...(item.created_at ? { created_at: item.created_at } : {}),
      ...(item.topics?.length ? { topics: item.topics } : {}),
      private: item.private || false, fork: item.fork || false, archived: item.archived || false,
      ...(item.default_branch ? { default_branch: item.default_branch } : {}),
    })),
  };
}

const direct = {
  get_me: async () => {
    const user = await get('/user');
    const details = Object.fromEntries(['name', 'company', 'blog', 'location', 'public_repos', 'public_gists', 'followers', 'following', 'created_at', 'updated_at'].filter(key => user[key] !== undefined).map(key => [key, user[key]]));
    return { login: user.login, id: user.id, profile_url: user.html_url, avatar_url: user.avatar_url, details };
  },
  get_team_members: a => get(`/orgs/${e(a.org)}/teams/${e(a.team_slug)}/members`),
  get_teams: a => get(a.user ? `/users/${e(a.user)}/teams` : '/user/teams'),
  get_code_quality_finding: a => get(`${repo(a)}/code-quality/findings/${e(a.findingNumber)}`),
  get_code_scanning_alert: a => get(`${repo(a)}/code-scanning/alerts/${e(a.alertNumber)}`),
  list_code_scanning_alerts: a => get(`${repo(a)}/code-scanning/alerts`, { ...paging(a), ...q(a, ['state', 'ref', 'severity']), tool_name: a.tool_name }),
  get_dependabot_alert: a => get(`${repo(a)}/dependabot/alerts/${e(a.alertNumber)}`),
  list_dependabot_alerts: a => get(`${repo(a)}/dependabot/alerts`, { after: a.after, per_page: a.perPage, state: a.state, severity: a.severity }),
  create_gist: a => post('/gists', { description: a.description, public: a.public ?? false, files: { [a.filename]: { content: a.content } } }),
  get_gist: a => get(`/gists/${e(a.gist_id)}`),
  list_gists: a => get(a.username ? `/users/${e(a.username)}/gists` : '/gists', { ...paging(a), since: a.since }),
  update_gist: a => patch(`/gists/${e(a.gist_id)}`, { description: a.description, files: { [a.filename]: { content: a.content } } }),
  get_repository_tree: async a => {
    const branch = a.tree_sha || awaitDefaultBranch(a);
    const data = await get(`${repo(a)}/git/trees/${e(branch)}`, { recursive: a.recursive ? 1 : undefined });
    return a.path_filter ? { ...data, tree: data.tree?.filter(item => item.path.startsWith(a.path_filter)) } : data;
  },
  add_issue_comment: a => a.reaction ? post(`${repo(a)}/issues/comments/${e(a.comment_id)}/reactions`, { content: a.reaction }) : post(`${issue(a)}/comments`, { body: a.body }),
  get_label: a => get(`${repo(a)}/labels/${e(a.name)}`),
  list_issue_fields: a => get(a.repo ? `${repo(a)}/issue-fields` : `/orgs/${e(a.owner)}/issue-fields`),
  list_issue_types: a => get(a.repo ? `${repo(a)}/issue-types` : `/orgs/${e(a.owner)}/issue-types`),
  search_issues: a => search('issues', a, ' is:issue'),
  update_issue_comment: a => patch(`${repo(a)}/issues/comments/${e(a.comment_id)}`, { body: a.body }),
  get_notification_details: a => get(`/notifications/threads/${e(a.notificationID)}`),
  list_notifications: a => get(a.owner && a.repo ? `${repo(a)}/notifications` : '/notifications', { ...paging(a), since: a.since, before: a.before, all: a.filter === 'include_read_notifications' ? true : undefined, participating: a.filter === 'only_participating' ? true : undefined }),
  dismiss_notification: a => patch(`/notifications/threads/${e(a.threadID)}`, { state: a.state }),
  mark_all_notifications_read: a => put(a.owner && a.repo ? `${repo(a)}/notifications` : '/notifications', a.lastReadAt ? { last_read_at: a.lastReadAt } : {}),
  search_orgs: a => searchAccounts(a, 'org'),
  list_pull_requests: async a => (await get(`${repo(a)}/pulls`, { ...paging(a), ...q(a, ['state', 'head', 'base', 'sort', 'direction']) })).map(pr => {
    const item = minimalPR(pr);
    return a.fields ? Object.fromEntries(Object.entries(item).filter(([key]) => a.fields.includes(key))) : item;
  }),
  create_pull_request: async a => {
    const result = await post(`${repo(a)}/pulls`, b(a, { title: 'title', head: 'head', base: 'base', body: 'body', draft: 'draft', maintainer_can_modify: 'maintainer_can_modify' }));
    if (a.reviewers?.length) await post(`${repo(a)}/pulls/${e(result.number)}/requested_reviewers`, { reviewers: a.reviewers });
    return result;
  },
  merge_pull_request: a => put(`${pull(a)}/merge`, b(a, { commit_title: 'commit_title', commit_message: 'commit_message', merge_method: 'merge_method', expectedHeadSha: 'sha' })),
  search_pull_requests: a => search('issues', a, ' is:pr'),
  update_pull_request_branch: a => put(`${pull(a)}/update-branch`, a.expectedHeadSha ? { expected_head_sha: a.expectedHeadSha } : {}),
  create_or_update_file: a => put(`${repo(a)}/contents/${encodePath(a.path)}`, { message: a.message, content: Buffer.from(a.content).toString('base64'), branch: a.branch, ...(a.sha ? { sha: a.sha } : {}) }),
  create_repository: a => post(a.organization ? `/orgs/${e(a.organization)}/repos` : '/user/repos', { name: a.name, description: a.description, private: a.private ?? true, auto_init: a.autoInit }),
  delete_file: async a => { const file = await get(`${repo(a)}/contents/${encodePath(a.path)}`, { ref: a.branch }); return del(`${repo(a)}/contents/${encodePath(a.path)}`, { message: a.message, branch: a.branch, sha: file.sha }); },
  delete_repository: a => del(repo(a)),
  fork_repository: a => post(`${repo(a)}/forks`, a.organization ? { organization: a.organization } : {}),
  get_commit: async a => {
    const result = await get(`${repo(a)}/commits/${e(a.sha)}`, paging(a));
    if (a.detail === 'none') { delete result.files; delete result.stats; }
    if (a.detail !== 'full_patch') for (const file of result.files || []) delete file.patch;
    return result;
  },
  get_file_contents: async a => {
    const result = await get(`${repo(a)}/contents/${encodePath(a.path || '')}`, { ref: a.sha || a.ref });
    if (Array.isArray(result)) return a.fields ? result.map(item => Object.fromEntries(Object.entries(item).filter(([key]) => a.fields.includes(key)))) : result;
    if (result.type === 'file' && result.sha) {
      const ref = a.sha || a.ref || (await get(repo(a))).default_branch;
      const commit = await get(`${repo(a)}/commits/${e(ref)}`);
      const uri = `repo://${e(a.owner)}/${e(a.repo)}/sha/${e(commit.sha)}/contents/${encodePath(a.path || result.path)}`;
      if (result.size >= 1024 * 1024) return { __mcpResult: { content: [
        { type: 'text', text: `File ${a.path || result.path} is too large to display (${result.size} bytes). Use the download URL to fetch the content: ${result.download_url} (SHA: ${result.sha})` },
        { type: 'resource_link', uri, name: result.name, title: `File: ${a.path || result.path}`, size: result.size },
      ] } };
      if (result.encoding === 'base64' && (typeof result.content === 'string' || result.size === 0)) {
        const bytes = Buffer.from((result.content || '').replace(/\s/g, ''), 'base64');
        const textContent = bytes.toString('utf8');
        const isText = !bytes.includes(0) && Buffer.from(textContent, 'utf8').equals(bytes);
        const mimeType = !bytes.length ? 'text/plain' : isText ? 'text/plain; charset=utf-8' : 'application/octet-stream';
        return { __mcpResult: { content: [
          { type: 'text', text: `successfully downloaded ${bytes.length ? isText ? 'text' : 'binary' : 'empty'} file (SHA: ${result.sha})` },
          { type: 'resource', resource: { uri, mimeType, ...(isText ? { text: textContent } : { blob: bytes.toString('base64') }) } },
        ] } };
      }
    }
    return result;
  },
  get_latest_release: a => get(`${repo(a)}/releases/latest`),
  get_release_by_tag: a => get(`${repo(a)}/releases/tags/${e(a.tag)}`),
  get_tag: async a => {
    const ref = await get(`${repo(a)}/git/ref/tags/${e(a.tag)}`);
    return ref.object?.type === 'tag' ? get(`${repo(a)}/git/tags/${e(ref.object.sha)}`) : ref;
  },
  list_branches: async a => (await get(`${repo(a)}/branches`, paging(a))).map(item => ({ name: item.name || '', sha: item.commit?.sha || '', protected: item.protected || false })),
  list_commits: a => get(`${repo(a)}/commits`, { ...paging(a), ...q(a, ['sha', 'path', 'author', 'since', 'until']) }),
  list_releases: a => get(`${repo(a)}/releases`, paging(a)),
  list_repository_collaborators: a => get(`${repo(a)}/collaborators`, { ...paging(a), affiliation: a.affiliation }),
  list_tags: async a => (await get(`${repo(a)}/tags`, paging(a))).map(item => ({ name: item.name || '', sha: item.commit?.sha || '' })),
  search_code: a => search('code', a),
  search_commits: a => search('commits', a),
  search_repositories: searchRepositories,
  get_secret_scanning_alert: a => get(`${repo(a)}/secret-scanning/alerts/${e(a.alertNumber)}`),
  list_secret_scanning_alerts: a => get(`${repo(a)}/secret-scanning/alerts`, { ...paging(a), ...q(a, ['state', 'secret_type', 'resolution']) }),
  get_global_security_advisory: a => get(`/advisories/${e(a.ghsaId)}`),
  list_global_security_advisories: a => get('/advisories', b(a, { ghsaId: 'ghsa_id', cveId: 'cve_id', ecosystem: 'ecosystem', severity: 'severity', type: 'type', affects: 'affects', cwes: 'cwes', published: 'published', updated: 'updated', modified: 'modified', isWithdrawn: 'is_withdrawn' })),
  list_org_repository_security_advisories: a => get(`/orgs/${e(a.org)}/security-advisories`, q(a, ['state', 'sort', 'direction'])),
  list_repository_security_advisories: a => get(`${repo(a)}/security-advisories`, q(a, ['state', 'sort', 'direction'])),
  list_starred_repositories: a => get(a.username ? `/users/${e(a.username)}/starred` : '/user/starred', { ...paging(a), sort: a.sort, direction: a.direction }),
  star_repository: a => put(`/user/starred/${e(a.owner)}/${e(a.repo)}`),
  unstar_repository: a => del(`/user/starred/${e(a.owner)}/${e(a.repo)}`),
  search_users: a => searchAccounts(a, 'user'),
};

function encodePath(path) {
  const parts = String(path).split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) throw new Error('Invalid repository path');
  return parts.map(e).join('/');
}
async function awaitDefaultBranch(a) { return (await get(repo(a))).default_branch; }

export async function execute(name, a) {
  if (direct[name]) return direct[name](a);
  if (advanced[name]) return advanced[name](a);
  if (discussionTools[name]) return discussionTools[name](a);
  if (copilotTools[name]) return copilotTools[name](a);
  if (projectTools[name]) return projectTools[name](a);
  switch (name) {
    case 'issue_read': {
      const paths = { get: issue(a), get_comments: `${issue(a)}/comments`, get_sub_issues: `${issue(a)}/sub_issues`, get_parent: `${issue(a)}/parent`, get_labels: `${issue(a)}/labels` };
      return get(paths[a.method], paging(a));
    }
    case 'issue_write': {
      const body = b(a, { title: 'title', body: 'body', assignees: 'assignees', labels: 'labels', milestone: 'milestone', state: 'state', state_reason: 'state_reason', type: 'type' });
      return a.method === 'create' ? post(`${repo(a)}/issues`, body) : patch(issue(a), body);
    }
    case 'list_issues': {
      if (a.after || a.field_filters?.length) throw new Error('Cursor and custom issue field filters require the GitHub GraphQL implementation');
      if (Boolean(a.orderBy) !== Boolean(a.direction)) throw new Error('orderBy and direction must be provided together');
      const result = await get(`${repo(a)}/issues`, { state: a.state?.toLowerCase() || 'all', labels: a.labels?.join(','), since: a.since, per_page: a.perPage, sort: a.orderBy?.toLowerCase(), direction: a.direction?.toLowerCase() });
      const issues = result.filter(item => !item.pull_request);
      return a.fields ? issues.map(item => Object.fromEntries(Object.entries(item).filter(([key]) => a.fields.includes(key)))) : issues;
    }
    case 'sub_issue_write': {
      const path = `${issue(a)}/sub_issues`;
      if (a.method === 'add') return post(path, { sub_issue_id: a.sub_issue_id, replace_parent: a.replace_parent });
      if (a.method === 'remove') return del(`${path}/${e(a.sub_issue_id)}`);
      if (a.method === 'reprioritize') return patch(`${path}/${e(a.sub_issue_id)}`, b(a, { after_id: 'after_id', before_id: 'before_id' }));
      throw new Error(`Unsupported method: ${a.method}`);
    }
    case 'label_write': {
      if (a.method === 'create') return post(`${repo(a)}/labels`, b(a, { name: 'name', color: 'color', description: 'description' }));
      if (a.method === 'update') return patch(`${repo(a)}/labels/${e(a.name)}`, b(a, { new_name: 'new_name', color: 'color', description: 'description' }));
      return del(`${repo(a)}/labels/${e(a.name)}`);
    }
    case 'list_label': return get(`${repo(a)}/labels`, { per_page: a.perPage, after: a.after });
    case 'pull_request_read': {
      const paths = { get: pull(a), get_diff: pull(a), get_files: `${pull(a)}/files`, get_commits: `${pull(a)}/commits`, get_review_comments: `${pull(a)}/comments`, get_reviews: `${pull(a)}/reviews`, get_comments: `${repo(a)}/issues/${e(a.pullNumber)}/comments` };
      if (a.method === 'get_status' || a.method === 'get_check_runs') {
        const pr = await get(pull(a));
        paths.get_status = `${repo(a)}/commits/${e(pr.head.sha)}/status`;
        paths.get_check_runs = `${repo(a)}/commits/${e(pr.head.sha)}/check-runs`;
      }
      const result = await get(paths[a.method], paging(a), a.method === 'get_diff' ? 'application/vnd.github.diff' : undefined);
      return a.method === 'get' ? minimalPR(result) : result;
    }
    case 'update_pull_request': {
      const result = await patch(pull(a), b(a, { title: 'title', body: 'body', state: 'state', base: 'base', maintainer_can_modify: 'maintainer_can_modify' }));
      if (a.reviewers?.length) await post(`${pull(a)}/requested_reviewers`, { reviewers: a.reviewers });
      if (a.draft !== undefined && result.draft !== a.draft) {
        const operation = a.draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
        const inputType = a.draft ? 'ConvertPullRequestToDraftInput' : 'MarkPullRequestReadyForReviewInput';
        const data = await graphql(`mutation($input:${inputType}!){${operation}(input:$input){pullRequest{id isDraft}}}`, { input: { pullRequestId: result.node_id } });
        if (data.errors?.length) throw new Error(data.errors.map(error => error.message).join('; '));
        result.draft = data.data[operation].pullRequest.isDraft;
      }
      return result;
    }
    case 'pull_request_review_write': {
      if (a.method === 'create') return post(`${pull(a)}/reviews`, b(a, { body: 'body', event: 'event', commitID: 'commit_id' }));
      if (a.method === 'resolve_thread' || a.method === 'unresolve_thread') {
        if (!a.threadId) throw new Error('threadId is required');
        const operation = a.method === 'resolve_thread' ? 'resolveReviewThread' : 'unresolveReviewThread';
        const inputType = a.method === 'resolve_thread' ? 'ResolveReviewThreadInput' : 'UnresolveReviewThreadInput';
        const data = await graphql(`mutation($input:${inputType}!){${operation}(input:$input){thread{id isResolved}}}`, { input: { threadId: a.threadId } });
        if (data.errors?.length) throw new Error(data.errors.map(error => error.message).join('; '));
        return data.data[operation].thread;
      }
      const reviews = await get(`${pull(a)}/reviews`);
      const pending = reviews.findLast(item => item.state === 'PENDING');
      if (!pending) throw new Error('No pending review');
      if (a.method === 'submit_pending') return post(`${pull(a)}/reviews/${e(pending.id)}/events`, b(a, { body: 'body', event: 'event' }));
      if (a.method === 'delete_pending') return del(`${pull(a)}/reviews/${e(pending.id)}`);
      throw new Error(`Unsupported method: ${a.method}`);
    }
    case 'add_comment_to_pending_review': {
      const reviews = await get(`${pull(a)}/reviews`);
      const pending = reviews.findLast(item => item.state === 'PENDING');
      if (!pending) throw new Error('No pending review');
      return post(`${pull(a)}/reviews/${e(pending.id)}/comments`, b(a, { body: 'body', path: 'path', line: 'line', side: 'side', startLine: 'start_line', startSide: 'start_side', subjectType: 'subject_type' }));
    }
    case 'add_reply_to_pull_request_comment': return a.reaction ? post(`${repo(a)}/pulls/comments/${e(a.commentId)}/reactions`, { content: a.reaction }) : post(`${repo(a)}/pulls/${e(a.pullNumber)}/comments/${e(a.commentId)}/replies`, { body: a.body });
    case 'create_branch': {
      const branch = a.from_branch || (await get(repo(a))).default_branch;
      const ref = await get(`${repo(a)}/git/ref/heads/${encodePath(branch)}`);
      return post(`${repo(a)}/git/refs`, { ref: `refs/heads/${a.branch}`, sha: ref.object.sha });
    }
    case 'manage_notification_subscription': return a.action === 'delete' ? del(`/notifications/threads/${e(a.notificationID)}/subscription`) : put(`/notifications/threads/${e(a.notificationID)}/subscription`, { ignored: a.action === 'ignore' });
    case 'manage_repository_notification_subscription': return a.action === 'delete' ? del(`${repo(a)}/subscription`) : put(`${repo(a)}/subscription`, { subscribed: a.action === 'watch', ignored: a.action === 'ignore' });
    default: throw new Error(`Tool is not implemented: ${name}`);
  }
}

export const implementedTools = new Set([...Object.keys(direct), ...Object.keys(advanced), ...Object.keys(discussionTools), ...Object.keys(copilotTools), ...Object.keys(projectTools), 'issue_read', 'issue_write', 'list_issues', 'sub_issue_write', 'label_write', 'list_label', 'pull_request_read', 'update_pull_request', 'pull_request_review_write', 'add_comment_to_pending_review', 'add_reply_to_pull_request_comment', 'create_branch', 'manage_notification_subscription', 'manage_repository_notification_subscription']);
