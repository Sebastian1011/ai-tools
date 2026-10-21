import { writeFile } from 'node:fs/promises';
import inventory from '../src/inventory.json' with { type: 'json' };
import { implementedTools } from '../src/tools.mjs';
import { advanced } from '../src/advanced.mjs';
import { discussionTools } from '../src/discussions.mjs';
import { copilotTools } from '../src/copilot.mjs';
import { projectTools } from '../src/projects.mjs';

const exceptions = {
  actions_get: '下载产物及日志的重定向/二进制输出未核对',
  get_job_logs: '日志重定向/文本输出未核对',
  get_file_contents: '公开 README 的 text/resource 与官方 A/B 一致；二进制、大文件和 symlink 未验证',
  list_issues: 'REST 近似；游标、自定义字段筛选未实现，分页可能含 PR 空位',
  pull_request_read: 'get 在公开样例 A/B 一致；get_review_comments 应返回 GraphQL review threads，当前为平铺 REST 评论',
  issue_read: '输出未按官方精简结构转换',
  search_issues: '官方语义搜索/自定义字段及输出裁剪未完全复现',
  search_pull_requests: '输出裁剪未完全复现',
  search_repositories: 'minimal_output 未实现',
  projects_get: 'REST/GraphQL 映射已写，输出未逐分支核对',
  projects_list: 'REST/GraphQL 映射已写，输出未逐分支核对',
  projects_write: 'REST/GraphQL 映射已写，写入未实测',
  ui_get: '当前返回普通 JSON；官方 UI 资源格式未实现',
};

const moduleFor = name => Object.hasOwn(advanced, name) ? 'advanced.mjs' : Object.hasOwn(discussionTools, name) ? 'discussions.mjs' : Object.hasOwn(copilotTools, name) ? 'copilot.mjs' : Object.hasOwn(projectTools, name) ? 'projects.mjs' : 'tools.mjs';
const freeMethods = { sub_issue_write: 'add, remove, reprioritize', manage_notification_subscription: 'ignore, watch, delete', manage_repository_notification_subscription: 'ignore, watch, delete' };
const rows = inventory.tools.map(tool => {
  const method = tool.inputSchema.properties?.method;
  const variants = method?.enum?.join(', ') || tool.inputSchema.properties?.action?.enum?.join(', ') || freeMethods[tool.name] || (method ? '自由字符串，见 schema 描述' : '—');
  const status = ['get_me', 'list_branches', 'list_pull_requests', 'search_users', 'search_repositories'].includes(tool.name) ? '公开样例/当前身份 A/B 文本输出一致' : exceptions[tool.name] || '名称/schema 一致；调用路径已映射，输出未逐项验证';
  return `| ${tool.name} | ${tool.toolset} | ${variants} | ${moduleFor(tool.name)} | ${status} |`;
});
if (inventory.tools.some(tool => !implementedTools.has(tool.name))) throw new Error('Some official tools have no local implementation');
const branches = inventory.tools.reduce((count, tool) => count + (tool.inputSchema.properties?.method?.enum?.length || tool.inputSchema.properties?.action?.enum?.length || (freeMethods[tool.name]?.split(', ').length) || 1), 0);
const content = `# 官方本地 GitHub MCP 与 gh 包装实现逐项对照\n\n官方基准：github/github-mcp-server 固定提交 \`${inventory.commit}\`，MCP 协议 \`2025-03-26\`。本表根据固定的官方 \`tools/list\` schema 与本仓库实现生成，共 ${inventory.tools.length} 个工具、${branches} 个分支或独立入口。\n\n“名称/schema 一致”只表示接口可发现；“调用路径已映射”表示代码会调用 \`gh api\`，不保证响应结构、分页和边界行为相同。写操作未向 GitHub 实测。详见下方已知差异。\n\n| 官方工具 | 工具集 | 官方 method/action 分支 | 本地实现 | 对照结论 |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\n## 已知差异和验收边界\n\n- \`get_me\`、\`list_branches\`、\`list_pull_requests\`、\`search_users\`、\`search_repositories\` 的文本结果，以及公开样例的 \`pull_request_read.get\` 和 README 的 \`get_file_contents\` 文本/resource 结果做过官方二进制与 Node 服务的实时 A/B 比较并一致。其它工具缺少逐项输出 A/B 证据，不能宣称完全一致。\n- 官方的 MCP resources、UI 资源、输出 schema/结构化结果、feature gates、lockdown 和高级 scope challenge 尚未复现。\n- \`get_file_contents\` 的二进制、大文件及 symlink 处理尚未验证；\`pull_request_read.get_review_comments\` 返回 REST 评论而非官方 GraphQL review threads。\n- \`list_issues\` 的游标及自定义字段筛选暂时明确报错；REST 近似分页可能少于请求数量。\n- 宿主机 gh 的现有 scope 决定实际可用权限；本地服务不扩权。\n`;
await writeFile(new URL('../docs/features/GITHUB-MCP/parity.md', import.meta.url), content);
console.log(`Wrote ${rows.length} tool rows covering ${branches} entries`);
