import { graphql } from './gh.mjs';

async function gql(query, variables) {
  const result = await graphql(query, variables);
  if (result.errors?.length) throw new Error(result.errors.map(error => error.message).join('; '));
  return result.data;
}

const location = a => ({ owner: a.owner, repo: a.repo || '.github' });
const header = 'id number title body url createdAt updatedAt isAnswered answerChosenAt author { login } category { name }';

async function discussion(a) {
  const data = await gql(`query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){discussion(number:$number){${header} comments(first:1){totalCount}}}}`, { ...location(a), number: a.discussionNumber });
  return data.repository?.discussion;
}

async function categories(a) {
  const data = await gql('query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){discussionCategories(first:100){nodes{id name} pageInfo{hasNextPage endCursor} totalCount}}}', location(a));
  const result = data.repository?.discussionCategories;
  return { categories: result?.nodes || [], pageInfo: result?.pageInfo, totalCount: result?.totalCount };
}

async function list(a) {
  const variables = { ...location(a), first: a.perPage || 30, after: a.after || null, category: a.category || null };
  const filter = a.category ? ',categoryId:$category' : '';
  const order = a.orderBy && a.direction ? `,orderBy:{field:${a.orderBy},direction:${a.direction}}` : '';
  const categoryVariable = a.category ? ',$category:ID' : '';
  const data = await gql(`query($owner:String!,$repo:String!,$first:Int!,$after:String${categoryVariable}){repository(owner:$owner,name:$repo){discussions(first:$first,after:$after${filter}${order}){nodes{${header}} pageInfo{hasNextPage endCursor} totalCount}}}`, variables);
  return data.repository?.discussions;
}

async function comments(a) {
  const variables = { ...location(a), number: a.discussionNumber, first: a.perPage || 30, after: a.after || null };
  const data = await gql('query($owner:String!,$repo:String!,$number:Int!,$first:Int!,$after:String){repository(owner:$owner,name:$repo){discussion(number:$number){comments(first:$first,after:$after){nodes{id body createdAt updatedAt author{login} replies(first:100){nodes{id body createdAt author{login}}}} pageInfo{hasNextPage endCursor} totalCount}}}}', variables);
  const output = data.repository?.discussion?.comments;
  if (!a.includeReplies && output) for (const item of output.nodes) delete item.replies;
  return output;
}

async function write(a) {
  const id = a.commentNodeID;
  if (a.method === 'add' || a.method === 'reply') {
    const item = await discussion(a);
    if (!item?.id) throw new Error('Discussion not found');
    const input = { discussionId: item.id, body: a.body };
    if (a.method === 'reply') input.replyToId = id;
    const data = await gql('mutation($input:AddDiscussionCommentInput!){addDiscussionComment(input:$input){comment{id body url}}}', { input });
    return data.addDiscussionComment.comment;
  }
  if (!id) throw new Error('commentNodeID is required');
  if (a.method === 'update') {
    const data = await gql('mutation($input:UpdateDiscussionCommentInput!){updateDiscussionComment(input:$input){comment{id body url}}}', { input: { commentId: id, body: a.body } });
    return data.updateDiscussionComment.comment;
  }
  if (a.method === 'delete') {
    const data = await gql('mutation($input:DeleteDiscussionCommentInput!){deleteDiscussionComment(input:$input){comment{id url}}}', { input: { id } });
    return data.deleteDiscussionComment.comment;
  }
  const op = a.method === 'mark_answer' ? 'markDiscussionCommentAsAnswer' : 'unmarkDiscussionCommentAsAnswer';
  const type = a.method === 'mark_answer' ? 'MarkDiscussionCommentAsAnswerInput' : 'UnmarkDiscussionCommentAsAnswerInput';
  const data = await gql(`mutation($input:${type}!){${op}(input:$input){discussion{id number}}}`, { input: { id } });
  return data[op].discussion;
}

export const discussionTools = {
  get_discussion: discussion,
  get_discussion_comments: comments,
  list_discussion_categories: categories,
  list_discussions: list,
  discussion_comment_write: write,
};
