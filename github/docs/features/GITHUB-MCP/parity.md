# 官方本地 GitHub MCP 与 gh 包装实现逐项对照

官方基准：github/github-mcp-server 固定提交 `e3809fe91c7546633241006bf0b91f23b2595e28`，MCP 协议 `2025-03-26`。本表根据固定的官方 `tools/list` schema 与本仓库实现生成，共 92 个工具、161 个分支或独立入口。

“名称/schema 一致”只表示接口可发现；“调用路径已映射”表示代码会调用 `gh api`，不保证响应结构、分页和边界行为相同。写操作未向 GitHub 实测。详见下方已知差异。

| 官方工具 | 工具集 | 官方 method/action 分支 | 本地实现 | 对照结论 |
| --- | --- | --- | --- | --- |
| actions_get | actions | get_workflow, get_workflow_run, get_workflow_job, download_workflow_run_artifact, get_workflow_run_usage, get_workflow_run_logs_url | advanced.mjs | 下载产物及日志的重定向/二进制输出未核对 |
| actions_list | actions | list_workflows, list_workflow_runs, list_workflow_jobs, list_workflow_run_artifacts | advanced.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| actions_run_trigger | actions | run_workflow, rerun_workflow_run, rerun_failed_jobs, cancel_workflow_run, delete_workflow_run_logs | advanced.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| get_job_logs | actions | — | advanced.mjs | 日志重定向/文本输出未核对 |
| get_code_quality_finding | code_quality | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| get_code_scanning_alert | code_security | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| list_code_scanning_alerts | code_security | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| get_me | context | — | tools.mjs | 公开样例/当前身份 A/B 文本输出一致 |
| get_team_members | context | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| get_teams | context | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| ui_get | context | labels, assignees, milestones, issue_types, branches, issue_fields, reviewers | advanced.mjs | 当前返回普通 JSON；官方 UI 资源格式未实现 |
| assign_copilot_to_issue | copilot | — | copilot.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| request_copilot_review | copilot | — | advanced.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| assign_copilot_to_issue_with_intent | copilot_issue_intents | — | copilot.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| get_dependabot_alert | dependabot | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| list_dependabot_alerts | dependabot | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| discussion_comment_write | discussions | add, reply, update, delete, mark_answer, unmark_answer | discussions.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| get_discussion | discussions | — | discussions.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| get_discussion_comments | discussions | — | discussions.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| list_discussion_categories | discussions | — | discussions.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| list_discussions | discussions | — | discussions.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| create_gist | gists | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| get_gist | gists | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| list_gists | gists | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| update_gist | gists | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| get_repository_tree | git | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| create_repository_ruleset | governance | — | advanced.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| custom_properties_read | governance | — | advanced.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| custom_properties_write | governance | — | advanced.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| repository_ruleset_read | governance | get, list, get_rules_for_branch, list_rule_suites, get_rule_suite | advanced.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| add_issue_comment | issues | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| get_label | issues | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| issue_read | issues | get, get_comments, get_sub_issues, get_parent, get_labels | tools.mjs | 输出未按官方精简结构转换 |
| issue_write | issues | create, update | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| list_issue_fields | issues | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| list_issue_types | issues | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| list_issues | issues | — | tools.mjs | REST 近似；游标、自定义字段筛选未实现，分页可能含 PR 空位 |
| search_issues | issues | — | tools.mjs | 官方语义搜索/自定义字段及输出裁剪未完全复现 |
| sub_issue_write | issues | add, remove, reprioritize | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| update_issue_comment | issues | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| label_write | labels | create, update, delete | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| list_label | labels | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| dismiss_notification | notifications | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| get_notification_details | notifications | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| list_notifications | notifications | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| manage_notification_subscription | notifications | ignore, watch, delete | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| manage_repository_notification_subscription | notifications | ignore, watch, delete | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| mark_all_notifications_read | notifications | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| search_orgs | orgs | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| projects_get | projects | get_project, get_project_field, get_project_item, get_project_status_update, get_project_view | projects.mjs | REST/GraphQL 映射已写，输出未逐分支核对 |
| projects_list | projects | list_projects, list_project_fields, list_project_items, list_project_status_updates, list_project_views | projects.mjs | REST/GraphQL 映射已写，输出未逐分支核对 |
| projects_write | projects | add_project_item, update_project_item, update_project_items, delete_project_item, create_project_status_update, create_project_view, update_project_view, delete_project_view, create_project, create_iteration_field | projects.mjs | REST/GraphQL 映射已写，写入未实测 |
| add_comment_to_pending_review | pull_requests | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| add_reply_to_pull_request_comment | pull_requests | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| create_pull_request | pull_requests | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| list_pull_requests | pull_requests | — | tools.mjs | 公开样例/当前身份 A/B 文本输出一致 |
| merge_pull_request | pull_requests | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| pull_request_read | pull_requests | get, get_diff, get_status, get_files, get_commits, get_review_comments, get_reviews, get_comments, get_check_runs | tools.mjs | get 在公开样例 A/B 一致；get_review_comments 应返回 GraphQL review threads，当前为平铺 REST 评论 |
| pull_request_review_write | pull_requests | create, submit_pending, delete_pending, resolve_thread, unresolve_thread | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| search_pull_requests | pull_requests | — | tools.mjs | 输出裁剪未完全复现 |
| update_pull_request | pull_requests | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| update_pull_request_branch | pull_requests | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| create_branch | repos | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| create_or_update_file | repos | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| create_repository | repos | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| delete_file | repos | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| delete_repository | repos | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| fork_repository | repos | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| get_commit | repos | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| get_file_contents | repos | — | tools.mjs | 公开 README 的 text/resource 与官方 A/B 一致；二进制、大文件和 symlink 未验证 |
| get_latest_release | repos | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| get_release_by_tag | repos | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| get_tag | repos | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| list_branches | repos | — | tools.mjs | 公开样例/当前身份 A/B 文本输出一致 |
| list_commits | repos | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| list_releases | repos | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| list_repository_collaborators | repos | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| list_tags | repos | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| push_files | repos | — | advanced.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| search_code | repos | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| search_commits | repos | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| search_repositories | repos | — | tools.mjs | 公开样例/当前身份 A/B 文本输出一致 |
| get_secret_scanning_alert | secret_protection | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| list_secret_scanning_alerts | secret_protection | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| get_global_security_advisory | security_advisories | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| list_global_security_advisories | security_advisories | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| list_org_repository_security_advisories | security_advisories | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| list_repository_security_advisories | security_advisories | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| list_starred_repositories | stargazers | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| star_repository | stargazers | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| unstar_repository | stargazers | — | tools.mjs | 名称/schema 一致；调用路径已映射，输出未逐项验证 |
| search_users | users | — | tools.mjs | 公开样例/当前身份 A/B 文本输出一致 |

## 已知差异和验收边界

- `get_me`、`list_branches`、`list_pull_requests`、`search_users`、`search_repositories` 的文本结果，以及公开样例的 `pull_request_read.get` 和 README 的 `get_file_contents` 文本/resource 结果做过官方二进制与 Node 服务的实时 A/B 比较并一致。其它工具缺少逐项输出 A/B 证据，不能宣称完全一致。
- 官方的 MCP resources、UI 资源、输出 schema/结构化结果、feature gates、lockdown 和高级 scope challenge 尚未复现。
- `get_file_contents` 的二进制、大文件及 symlink 处理尚未验证；`pull_request_read.get_review_comments` 返回 REST 评论而非官方 GraphQL review threads。
- `list_issues` 的游标及自定义字段筛选暂时明确报错；REST 近似分页可能少于请求数量。
- 宿主机 gh 的现有 scope 决定实际可用权限；本地服务不扩权。
