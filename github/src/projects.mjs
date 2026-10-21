import { api, graphql } from './gh.mjs';

const e = value => encodeURIComponent(String(value));
const headers = ['X-GitHub-Api-Version: 2026-03-10'];
const viewLayouts = { table: 'TABLE_LAYOUT', board: 'BOARD_LAYOUT', roadmap: 'ROADMAP_LAYOUT' };
const rest = (method, path, { query, body } = {}) => api(method, path, { query, body, headers });

async function gql(query, variables) {
  const result = await graphql(query, variables);
  if (result.errors?.length) throw new Error(result.errors.map(error => error.message).join('; '));
  return result.data;
}

function projectBase(a) {
  if (!a.owner) throw new Error('owner is required');
  if (a.owner_type === 'org') return `/orgs/${e(a.owner)}/projectsV2`;
  if (a.owner_type === 'user') return `/users/${e(a.owner)}/projectsV2`;
  throw new Error('owner_type must be user or org');
}

async function ownerType(a) {
  if (a.owner_type) return a.owner_type;
  const result = await api('GET', `/users/${e(a.owner)}`);
  return result.type === 'Organization' ? 'org' : 'user';
}

async function base(a) { return projectBase({ ...a, owner_type: await ownerType(a) }); }
async function numbered(a) {
  if (!a.project_number) throw new Error('project_number is required');
  return `${await base(a)}/${e(a.project_number)}`;
}

async function projectNode(a) {
  const type = await ownerType(a);
  const field = type === 'org' ? 'organization' : 'user';
  const data = await gql(`query($owner:String!,$number:Int!){${field}(login:$owner){projectV2(number:$number){id title number}}}`, { owner: a.owner, number: a.project_number });
  const item = data[field]?.projectV2;
  if (!item) throw new Error('Project not found');
  return item;
}

async function ownerNode(a) {
  const type = await ownerType(a);
  const field = type === 'org' ? 'organization' : 'user';
  const data = await gql(`query($owner:String!){${field}(login:$owner){id}}`, { owner: a.owner });
  if (!data[field]?.id) throw new Error('Project owner not found');
  return data[field].id;
}

const viewFields = 'id number name layout filter configuration{visibleFields(first:100){nodes{... on ProjectV2Field{id databaseId} ... on ProjectV2SingleSelectField{id databaseId} ... on ProjectV2IterationField{id databaseId} ... on ProjectV2MultiSelectField{id databaseId}}}}';
const updateFields = 'id body status createdAt startDate targetDate creator{login}';

async function listGraphql(a, kind) {
  const type = await ownerType(a);
  const field = type === 'org' ? 'organization' : 'user';
  const connection = kind === 'views' ? `views(first:$first,after:$after){nodes{${viewFields}} pageInfo{hasNextPage endCursor}}` : `statusUpdates(first:$first,after:$after,orderBy:{field:CREATED_AT,direction:DESC}){nodes{${updateFields}} pageInfo{hasNextPage endCursor}}`;
  const data = await gql(`query($owner:String!,$number:Int!,$first:Int!,$after:String){${field}(login:$owner){projectV2(number:$number){${connection}}}}`, { owner: a.owner, number: a.project_number, first: a.perPage || 30, after: a.after || null });
  const result = data[field]?.projectV2?.[kind];
  if (!result) throw new Error('Project not found');
  return { [kind]: result.nodes, pageInfo: result.pageInfo };
}

async function getNode(id, type, fields) {
  const data = await gql(`query($id:ID!){node(id:$id){... on ${type}{${fields}}}}`, { id });
  return data.node;
}

async function projectFields(a) {
  const fields = await rest('GET', `${await numbered(a)}/fields`, { query: { per_page: 100 } });
  return Array.isArray(fields) ? fields : fields.fields || [];
}

async function fieldIds(a) {
  if (a.fields && a.field_names) throw new Error('Use either fields or field_names');
  if (!a.field_names) return a.fields;
  const available = await projectFields(a);
  return a.field_names.map(name => {
    const field = available.find(item => item.name === name);
    if (!field) throw new Error(`Project field not found: ${name}`);
    return String(field.id);
  });
}

async function updatedField(a) {
  const input = a.updated_field;
  if (!input || !Object.hasOwn(input, 'value')) throw new Error('updated_field with a value is required');
  if (input.id !== undefined) return { id: input.id, value: input.value };
  if (!input.name) throw new Error('updated_field requires id or name');
  const field = (await projectFields(a)).find(item => item.name === input.name);
  if (!field) throw new Error(`Project field not found: ${input.name}`);
  let value = input.value;
  if (typeof value === 'string' && field.data_type === 'SINGLE_SELECT') {
    const option = field.options?.find(item => item.name === value || item.id === value);
    if (!option) throw new Error(`Project field option not found: ${value}`);
    value = option.id;
  }
  return { id: field.id, value };
}

async function itemId(a, item) {
  if (item.item_id !== undefined) return item.item_id;
  if (item.node_id) {
    const result = await getNode(item.node_id, 'ProjectV2Item', 'fullDatabaseId');
    if (!result?.fullDatabaseId) throw new Error('Project item node not found');
    return result.fullDatabaseId;
  }
  if (item.item_owner && item.item_repo && item.issue_number) {
    const issue = await api('GET', `/repos/${e(item.item_owner)}/${e(item.item_repo)}/issues/${e(item.issue_number)}`);
    const list = await rest('GET', `${await numbered(a)}/items`, { query: { per_page: 100 } });
    const items = Array.isArray(list) ? list : list.items || [];
    const match = items.find(entry => entry.content?.node_id === issue.node_id || entry.content?.id === issue.id);
    if (match) return match.id;
  }
  throw new Error('Project item not found');
}

async function mutate(name, type, input, fields) {
  const data = await gql(`mutation($input:${type}!){${name}(input:$input){${fields}}}`, { input });
  return data[name];
}

async function list(a) {
  if (a.method === 'list_projects') return rest('GET', await base(a), { query: { per_page: a.perPage, query: a.query, after: a.after, before: a.before } });
  if (a.method === 'list_project_fields') return rest('GET', `${await numbered(a)}/fields`, { query: { per_page: a.perPage, after: a.after, before: a.before } });
  if (a.method === 'list_project_items') return rest('GET', `${await numbered(a)}/items`, { query: { per_page: a.perPage, after: a.after, before: a.before, query: a.query, fields: (await fieldIds(a))?.join(',') } });
  if (a.method === 'list_project_views') return listGraphql(a, 'views');
  if (a.method === 'list_project_status_updates') return listGraphql(a, 'statusUpdates');
  throw new Error(`Unknown project list method: ${a.method}`);
}

async function get(a) {
  if (a.method === 'get_project') return rest('GET', await numbered(a));
  if (a.method === 'get_project_field') return rest('GET', `${await numbered(a)}/fields/${e(a.field_id)}`);
  if (a.method === 'get_project_item') return rest('GET', `${await numbered(a)}/items/${e(a.item_id)}`, { query: { fields: (await fieldIds(a))?.join(',') } });
  if (a.method === 'get_project_view') return getNode(a.view_id, 'ProjectV2View', viewFields);
  if (a.method === 'get_project_status_update') return getNode(a.status_update_id, 'ProjectV2StatusUpdate', updateFields);
  throw new Error(`Unknown project get method: ${a.method}`);
}

async function write(a) {
  if (a.method === 'create_project') {
    const ownerId = await ownerNode(a);
    return (await mutate('createProjectV2', 'CreateProjectV2Input', { ownerId, title: a.title }, 'projectV2{id number title url}')).projectV2;
  }
  if (a.method === 'add_project_item') {
    const project = await projectNode(a);
    const kind = a.item_type === 'pull_request' ? 'pullRequest' : 'issue';
    const data = await gql(`query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){${kind}(number:$number){id}}}`, { owner: a.item_owner, repo: a.item_repo, number: a.item_type === 'pull_request' ? a.pull_request_number : a.issue_number });
    const contentId = data.repository?.[kind]?.id;
    if (!contentId) throw new Error('Project item content not found');
    return (await mutate('addProjectV2ItemById', 'AddProjectV2ItemByIdInput', { projectId: project.id, contentId }, 'item{id fullDatabaseId}')).item;
  }
  if (a.method === 'update_project_item') return rest('PATCH', `${await numbered(a)}/items/${e(a.item_id)}`, { body: { fields: [await updatedField(a)] } });
  if (a.method === 'update_project_items') {
    const results = [];
    const field = await updatedField(a);
    for (const item of a.items || []) results.push(await rest('PATCH', `${await numbered(a)}/items/${e(await itemId(a, item))}`, { body: { fields: [field] } }));
    return { items: results };
  }
  if (a.method === 'delete_project_item') return rest('DELETE', `${await numbered(a)}/items/${e(a.item_id)}`);
  if (a.method === 'create_project_status_update') {
    const project = await projectNode(a);
    const input = { projectId: project.id };
    for (const [key, value] of Object.entries({ body: a.body, status: a.status, startDate: a.start_date, targetDate: a.target_date })) if (value !== undefined) input[key] = value;
    return (await mutate('createProjectV2StatusUpdate', 'CreateProjectV2StatusUpdateInput', input, `statusUpdate{${updateFields}}`)).statusUpdate;
  }
  if (a.method === 'create_project_view') {
    const project = await projectNode(a);
    const input = { projectId: project.id, name: a.name, layout: viewLayouts[a.layout] };
    const visibleFields = await fieldIds({ ...a, fields: a.visible_fields, field_names: a.visible_field_names });
    if (visibleFields) input.configuration = { visibleFieldIds: visibleFields };
    const view = (await mutate('createProjectV2View', 'CreateProjectV2ViewInput', input, `projectV2View{${viewFields}}`)).projectV2View;
    if (a.filter !== undefined) return (await mutate('updateProjectV2View', 'UpdateProjectV2ViewInput', { viewId: view.id, filter: a.filter || '' }, `projectV2View{${viewFields}}`)).projectV2View;
    return view;
  }
  if (a.method === 'update_project_view') {
    const input = { viewId: a.view_id };
    for (const key of ['name', 'layout', 'filter']) if (a[key] !== undefined) input[key] = key === 'layout' ? viewLayouts[a[key]] : a[key] ?? '';
    const visibleFields = await fieldIds({ ...a, fields: a.visible_fields, field_names: a.visible_field_names });
    if (visibleFields) input.configuration = { visibleFieldIds: visibleFields };
    return (await mutate('updateProjectV2View', 'UpdateProjectV2ViewInput', input, `projectV2View{${viewFields}}`)).projectV2View;
  }
  if (a.method === 'delete_project_view') return (await mutate('deleteProjectV2View', 'DeleteProjectV2ViewInput', { viewId: a.view_id }, 'projectV2View{id}')).projectV2View;
  if (a.method === 'create_iteration_field') {
    const project = await projectNode(a);
    const field = (await mutate('createProjectV2Field', 'CreateProjectV2FieldInput', { projectId: project.id, dataType: 'ITERATION', name: a.field_name }, 'projectV2Field{... on ProjectV2IterationField{id name}}')).projectV2Field;
    const configuration = { duration: a.iteration_duration, startDate: a.start_date, iterations: (a.iterations || []).map(item => ({ title: item.title, startDate: item.start_date, duration: item.duration })) };
    return (await mutate('updateProjectV2Field', 'UpdateProjectV2FieldInput', { fieldId: field.id, iterationConfiguration: configuration }, 'projectV2Field{... on ProjectV2IterationField{id name}}')).projectV2Field;
  }
  throw new Error(`Unknown project write method: ${a.method}`);
}

export const projectTools = { projects_list: list, projects_get: get, projects_write: write };
