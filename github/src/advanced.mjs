import { api, graphql } from './gh.mjs';

const e = value => encodeURIComponent(String(value));
const r = a => `/repos/${e(a.owner)}/${e(a.repo)}`;
const get = (path, query) => api('GET', path, { query });
const post = (path, body) => api('POST', path, { body });
const patch = (path, body) => api('PATCH', path, { body });
const del = path => api('DELETE', path);
const pages = a => ({ page: a.page, per_page: a.perPage });

function rulesetBase(a) {
  if (a.level === 'repository') return `${r(a)}/rulesets`;
  if (a.level === 'organization') return `/orgs/${e(a.org)}/rulesets`;
  if (a.level === 'enterprise') return `/enterprises/${e(a.enterprise)}/rulesets`;
  throw new Error(`Unknown ruleset level: ${a.level}`);
}
function propertyBase(a) {
  if (a.level === 'repository') return `${r(a)}/properties/values`;
  if (a.level === 'organization') return `/orgs/${e(a.org)}/properties/schema`;
  if (a.level === 'enterprise') return `/enterprises/${e(a.enterprise)}/properties/schema`;
  throw new Error(`Unknown property level: ${a.level}`);
}
async function writeProperties(a) {
  const path = propertyBase(a);
  if (a.level === 'repository') return patch(path, { properties: a.properties });
  const existing = await get(path);
  const current = new Map(existing.map(item => [item.property_name, item]));
  const fields = ['value_type', 'required', 'default_value', 'description', 'allowed_values', 'values_editable_by', 'require_explicit_values'];
  const properties = a.properties.map(item => {
    const previous = current.get(item.property_name);
    if (!previous && !item.value_type) throw new Error(`value_type is required for new property ${item.property_name}`);
    if (previous?.source_type && previous.source_type !== a.level) throw new Error(`Cannot update inherited property ${item.property_name}`);
    return { property_name: item.property_name, ...Object.fromEntries(fields.filter(key => (previous && key in previous) || key in item).map(key => [key, key in item ? item[key] : previous[key]])) };
  });
  return patch(path, { properties });
}

async function actionsGet(a) {
  const base = `${r(a)}/actions`;
  const routes = {
    get_workflow: `/workflows/${e(a.resource_id)}`,
    get_workflow_run: `/runs/${e(a.resource_id)}`,
    get_workflow_job: `/jobs/${e(a.resource_id)}`,
    download_workflow_run_artifact: `/artifacts/${e(a.resource_id)}/zip`,
    get_workflow_run_usage: `/runs/${e(a.resource_id)}/timing`,
    get_workflow_run_logs_url: `/runs/${e(a.resource_id)}/logs`,
  };
  if (!routes[a.method]) throw new Error(`Unknown Actions method: ${a.method}`);
  return get(base + routes[a.method]);
}
async function actionsList(a) {
  const base = `${r(a)}/actions`;
  const routes = {
    list_workflows: '/workflows',
    list_workflow_runs: a.resource_id ? `/workflows/${e(a.resource_id)}/runs` : '/runs',
    list_workflow_jobs: `/runs/${e(a.resource_id)}/jobs`,
    list_workflow_run_artifacts: `/runs/${e(a.resource_id)}/artifacts`,
  };
  if (!routes[a.method]) throw new Error(`Unknown Actions method: ${a.method}`);
  return get(base + routes[a.method], { ...pages(a), ...(a.workflow_runs_filter || {}), ...(a.workflow_jobs_filter || {}) });
}
async function actionsTrigger(a) {
  const base = `${r(a)}/actions`;
  if (a.method === 'run_workflow') return post(`${base}/workflows/${e(a.workflow_id)}/dispatches`, { ref: a.ref, inputs: a.inputs });
  const routes = { rerun_workflow_run: 'rerun', rerun_failed_jobs: 'rerun-failed-jobs', cancel_workflow_run: 'cancel', delete_workflow_run_logs: 'logs' };
  if (!routes[a.method]) throw new Error(`Unknown Actions method: ${a.method}`);
  const path = `${base}/runs/${e(a.run_id)}/${routes[a.method]}`;
  return a.method === 'delete_workflow_run_logs' ? del(path) : post(path, {});
}

async function pushFiles(a) {
  for (const file of a.files) {
    if (!file.path || file.path.startsWith('/') || file.path.split('/').includes('..') || typeof file.content !== 'string') throw new Error('Each file needs a relative path and string content');
  }
  const branchPath = `${r(a)}/git/ref/heads/${a.branch.split('/').map(e).join('/')}`;
  const head = await get(branchPath);
  const parent = await get(`${r(a)}/git/commits/${e(head.object.sha)}`);
  const tree = await post(`${r(a)}/git/trees`, { base_tree: parent.tree.sha, tree: a.files.map(file => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })) });
  const commit = await post(`${r(a)}/git/commits`, { message: a.message, tree: tree.sha, parents: [head.object.sha] });
  await patch(branchPath, { sha: commit.sha, force: false });
  return { sha: commit.sha, html_url: `https://github.com/${a.owner}/${a.repo}/commit/${commit.sha}` };
}

async function uiGet(a) {
  const paths = {
    labels: `${r(a)}/labels`, assignees: `${r(a)}/assignees`, milestones: `${r(a)}/milestones`,
    issue_types: `/orgs/${e(a.owner)}/issue-types`, branches: `${r(a)}/branches`,
    issue_fields: `${r(a)}/issue-fields`, reviewers: `${r(a)}/collaborators`,
  };
  return { method: a.method, items: await get(paths[a.method], { per_page: 100 }) };
}

async function rulesetRead(a) {
  const base = rulesetBase(a);
  if (a.method === 'get') return get(`${base}/${e(a.ruleset_id)}`, { includes_parents: a.includes_parents });
  if (a.method === 'list') return get(base, { ...pages(a), includes_parents: a.includes_parents });
  if (a.method === 'get_rules_for_branch') return get(`${r(a)}/rules/branches/${e(a.branch)}`);
  if (a.method === 'list_rule_suites') return get(`${r(a)}/rulesets/rule-suites`, { ...pages(a), ref: a.ref, time_period: a.time_period, rule_suite_result: a.rule_suite_result });
  if (a.method === 'get_rule_suite') return get(`${r(a)}/rulesets/rule-suites/${e(a.rule_suite_id)}`);
  throw new Error(`Unknown ruleset method: ${a.method}`);
}

export const advanced = {
  actions_get: actionsGet,
  actions_list: actionsList,
  actions_run_trigger: actionsTrigger,
  get_job_logs: a => get(a.job_id ? `${r(a)}/actions/jobs/${e(a.job_id)}/logs` : `${r(a)}/actions/runs/${e(a.run_id)}/logs`),
  ui_get: uiGet,
  request_copilot_review: a => post(`${r(a)}/pulls/${e(a.pullNumber)}/requested_reviewers`, { reviewers: ['copilot-pull-request-reviewer[bot]'] }),
  create_repository_ruleset: a => post(rulesetBase(a), { name: a.name, enforcement: a.enforcement, target: a.target || 'branch', rules: a.rules, conditions: a.conditions, bypass_actors: a.bypass_actors }),
  custom_properties_read: a => get(propertyBase(a)),
  custom_properties_write: writeProperties,
  repository_ruleset_read: rulesetRead,
  push_files: pushFiles,
};
