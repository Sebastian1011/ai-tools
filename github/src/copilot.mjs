import { graphql } from './gh.mjs';

async function gql(query, variables, features = false) {
  const result = await graphql(query, variables, features ? ['GraphQL-Features: issues_copilot_assignment_api_support'] : []);
  if (result.errors?.length) throw new Error(result.errors.map(error => error.message).join('; '));
  return result.data;
}

async function findCopilot(a) {
  let after = null;
  do {
    const data = await gql('query($owner:String!,$repo:String!,$after:String){repository(owner:$owner,name:$repo){suggestedActors(first:100,after:$after,capabilities:CAN_BE_ASSIGNED){nodes{__typename ... on Bot{id login}} pageInfo{hasNextPage endCursor}}}}', { owner: a.owner, repo: a.repo, after });
    const actors = data.repository?.suggestedActors;
    const bot = actors?.nodes.find(node => node.login === 'copilot-swe-agent');
    if (bot) return bot;
    after = actors?.pageInfo.hasNextPage ? actors.pageInfo.endCursor : null;
  } while (after);
  throw new Error('Copilot is not available as an assignee for this repository');
}

async function issueContext(a) {
  const data = await gql('query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){id issue(number:$number){id assignees(first:100){nodes{id}}}}}', { owner: a.owner, repo: a.repo, number: a.issue_number });
  if (!data.repository?.issue) throw new Error('Issue not found');
  return data.repository;
}

async function assign(a, withIntent) {
  if (withIntent) {
    if (!a.rationale?.trim() || [...a.rationale.trim()].length > 280) throw new Error('rationale must be 1 to 280 characters');
    if (!['LOW', 'MEDIUM', 'HIGH'].includes(a.confidence?.toUpperCase())) throw new Error('confidence must be LOW, MEDIUM, or HIGH');
  }
  const bot = await findCopilot(a);
  const context = await issueContext(a);
  const preserved = context.issue.assignees.nodes.filter(node => node.id !== bot.id).map(node => withIntent ? { actorId: node.id } : node.id);
  const agent = { customAgent: '', customInstructions: a.custom_instructions || '', targetRepositoryId: context.id };
  if (a.base_ref) agent.baseRef = a.base_ref;
  const input = { id: context.issue.id };
  if (withIntent) {
    input.assignees = [...preserved, { actorId: bot.id, rationale: a.rationale.trim(), confidence: a.confidence.toUpperCase(), suggest: a.is_suggestion }];
    if (!a.is_suggestion) input.agentAssignment = agent;
  } else {
    input.assigneeIds = [...preserved, bot.id];
    input.agentAssignment = agent;
  }
  const result = await gql('mutation($input:UpdateIssueInput!){updateIssue(input:$input){issue{id number url}}}', { input }, true);
  return { issue_number: result.updateIssue.issue.number, issue_url: result.updateIssue.issue.url, message: a.is_suggestion ? 'Copilot assignment suggested' : 'Copilot assigned to issue' };
}

export const copilotTools = {
  assign_copilot_to_issue: a => assign(a, false),
  assign_copilot_to_issue_with_intent: a => assign(a, true),
};
