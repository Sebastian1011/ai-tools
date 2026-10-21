# ai-tools

自用的 MCP servers 与 Claude Code / Codex skills 集合。

## 获取仓库

```bash
git clone https://github.com/Sebastian1011/ai-tools.git
cd ai-tools
```

下文命令均在仓库根目录执行。Skill 通过软链接安装，因此移动或删除仓库后链接会失效；安装完成后请重启 Claude Code / Codex 会话。

## 全局 prompt

[`prompts/AGENT.md`](prompts/AGENT.md) 是 Claude Code 与 Codex 共用的全局 prompt 正本（行为准则、工作方式、工具使用约定）。安装脚本把它软链接到 `~/.claude/CLAUDE.md` 和各 Codex profile 的 `AGENTS.md`，之后改动只需编辑仓库里这一份：

```bash
cd prompts
./install.sh                       # 默认 Claude + $CODEX_HOME
./install.sh --codex-home ~/.codex-seb --codex-home ~/.codex-midas
./install.sh --check               # 只报告漂移，不写入
```

已存在且不是软链接的目标会先备份为 `<file>.ai-tools.bak`。与 skill 一样，移动或删除仓库会让链接失效。

## Skills

### [`privileged-exec`](agent-privexec/)

通过 Polkit 为 AI coding agent 提供受策略约束、需用户确认的 Linux 提权执行能力。需要 Linux 桌面环境、Polkit、`pkexec` 和 Python 3.11+。

先安装系统边界，再以普通用户安装 agent 规则与 skill：

```bash
cd agent-privexec
sudo ./install.sh
./install-agents.sh
```

只安装指定的 agent 配置或 skill 时，可使用 `./install-agents.sh --codex`、`--claude` 或 `--skill`。完整说明与卸载方法见 [`agent-privexec/README.md`](agent-privexec/README.md)。

### [`remote-exec`](remote-exec/)

通过 SSH 在远端机器上执行命令，且**每条命令执行前先由 reviewer 子代理做安全分类**：
只读操作和从远端取数据直接执行，写入非临时目录、修改机器配置等风险操作需用户显式确认，
破坏性操作直接拒绝。策略可通过 `~/.claude/remote-exec/rules.toml` 扩展。
连接配置沿用 `~/.ssh/config`，skill 只引用 host 别名。需要 Python 3.11+。

```bash
cd remote-exec
./install.sh              # 同时安装到 Claude Code 和 Codex
./install.sh --claude     # 仅 Claude Code
./install.sh --codex      # 仅 Codex
```

除 skill 与 reviewer 子代理外，还会安装确定性执行层：Claude Code 与 Codex 共用同一个
`PreToolUse` hook（两端实测生效；Codex 需要把 hook 的信任条目写进 `config.toml`，安装器会
自动完成并校验），Codex 另有一层 execpolicy 规则兜底。多个 Codex profile 用可重复的
`--codex-home` 一次装好：

```bash
./install.sh --claude --codex-home ~/.codex-midas --codex-home ~/.codex-seb
```

卸载运行 `./uninstall.sh`（保留你的规则文件）。完整说明、默认策略、Codex 信任机制与
威胁模型见 [`remote-exec/README.md`](remote-exec/README.md)。

### [`minio`](minio/)

使用 `mc` CLI 操作 MinIO 及 S3 兼容对象存储。使用前需先[安装 MinIO Client](https://min.io/docs/minio/linux/reference/minio-mc.html)。

```bash
cd minio
./install.sh              # 同时安装到 Claude Code 和 Codex
./install.sh --claude     # 仅 Claude Code
./install.sh --codex      # 仅 Codex
```

卸载运行 `./uninstall.sh`。更多信息见 [`minio/README.md`](minio/README.md)。

### [`delegate-worker`](ai-worker/skills/delegate-worker/)

将低风险、高上下文量的仓库检索、内容压缩和视觉任务委托给本地 `ai-worker` CLI。仓库仅包含 skill，不包含 `ai-worker` CLI 的安装程序；安装前请确认 `ai-worker` 已在 `PATH` 中。

```bash
mkdir -p ~/.claude/skills ~/.codex/skills
ln -sfnT "$PWD/ai-worker/skills/delegate-worker" ~/.claude/skills/delegate-worker
ln -sfnT "$PWD/ai-worker/skills/delegate-worker" ~/.codex/skills/delegate-worker
```

如只使用其中一个 agent，只需执行对应的软链接命令。

### [`markdown-preview`](markdown-preview/)

在本地浏览器实时预览 Markdown，支持 Mermaid、KaTeX、代码高亮、表格和本地图片。需要 Python 3，无需安装额外 Python 包；增强渲染资源从 `cdn.jsdelivr.net` 加载。

```bash
mkdir -p ~/.claude/skills ~/.codex/skills
ln -sfnT "$PWD/markdown-preview" ~/.claude/skills/markdown-preview
ln -sfnT "$PWD/markdown-preview" ~/.codex/skills/markdown-preview
```

如只使用其中一个 agent，只需执行对应的软链接命令。

## MCP servers

### [`akshare`](akshare/)

基于 [akshare](https://akshare.akfamily.xyz/index.html) 的金融行情 MCP，提供 16 类市场的标的检索、实时行情和多周期历史 K 线。推荐使用 Docker Compose 安装：

```bash
cd akshare
cp .env.example .env
docker compose up -d --build
curl -fsS http://localhost:8890/healthz
```

服务启动后，按使用的客户端注册 MCP：

```bash
# Claude Code
claude mcp add --transport http akshare http://localhost:8890/mcp

# Codex
codex mcp add akshare --url http://localhost:8890/mcp
```

查看日志使用 `docker compose logs -f akshare-mcp`，停止服务使用 `docker compose down`。开发环境、本地 `uv` 运行方式及配置项见 [`akshare/README.md`](akshare/README.md)。
