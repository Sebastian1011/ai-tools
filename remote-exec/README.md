# remote-exec

给 AI coding agent 的 SSH 远端执行 skill：**每一条远端命令在执行前先过一次安全审查**。
安全的直接跑，有风险的必须拿到用户显式确认，破坏性的直接拒绝。

连接配置不在本 skill 范围内 —— host、user、key、port 都在 `~/.ssh/config` 里，
skill 只引用 host 别名。**agent 不去读那个目录**：`~/.ssh` 下的配置、密钥、known_hosts
一律由 hook 拦下；别名按用户给的原样使用，解析不了或连不上就把 ssh 的报错原样交给用户。

```
remote-exec 请求
        ↓
remote-exec-reviewer 子代理
        ↓
      分类
   ┌────┴────┐
 safe       risky
   │          │
 执行       问用户
              │
           确认?
          ┌──┴──┐
         是     否
          │      │
        执行    中止
```

## 组成

| 文件 | 作用 |
|---|---|
| `skills/remote-exec/SKILL.md` | 行为契约：怎么构造命令、怎么送审、拿到判定后怎么做 |
| `skills/remote-exec/references/policy.md` | 策略唯一来源：求值顺序 + 内置 safe/risky/deny 清单 + 规则文件 schema |
| `agents/remote-exec-reviewer.md` | 审查子代理定义（Claude Code 与 Codex 共用同一份正文） |
| `hooks/remote-exec-guard.py` | PreToolUse hook，确定性执行层（两个 agent 共用同一份脚本） |
| `agents/codex/remote-exec.rules` | Codex execpolicy 规则，Codex 侧的第二层兜底 |
| `scripts/codex-trust-hook.py` | 记录并校验 Codex 的 hook 信任（否则 hook 会被静默跳过）|
| `config/rules.example.toml` | 用户规则模板，安装到 `~/.claude/remote-exec/rules.toml` |
| `tests/test_hook.sh`、`tests/test_rules.sh`、`tests/test_codex_rules.sh` | 表驱动测试：内置策略、用户规则、Codex 规则 |

审查结论以一个惰性的环境变量前缀带给 hook（ssh 默认不转发它）：

```bash
REMOTE_EXEC_REVIEW=safe     ssh web1 -- journalctl -u nginx -n 100
REMOTE_EXEC_REVIEW=approved ssh web1 -- systemctl restart nginx   # 用户已确认
```

## 安装

需要 Python 3.11+（hook 用 `tomllib` 解析规则文件）。

```bash
cd remote-exec
./install.sh              # Claude Code + Codex（$CODEX_HOME 指向的那个 profile）
./install.sh --claude     # 只装 Claude Code
./install.sh --codex      # 只装 Codex

# 多个 Codex profile：--codex-home 可重复
./install.sh --claude --codex-home ~/.codex-midas --codex-home ~/.codex-seb
```

安装内容：

- skill 软链接到 `$CLAUDE_HOME/skills/remote-exec`、`$CODEX_HOME/skills/remote-exec`
- reviewer 定义到 `~/.claude/agents/`、`$CODEX_HOME/agents/`
- hook 到 `~/.claude/hooks/`、`$CODEX_HOME/hooks/`，并分别注册进
  `~/.claude/settings.json` 与 `$CODEX_HOME/hooks.json` 的 `PreToolUse`
  （改动前先备份 `.remote-exec.bak`，同 matcher 上已有的其它 hook 不动）
- Codex 的 `[features].hooks = true`，以及 execpolicy 规则
  `$CODEX_HOME/rules/remote-exec.rules`
- 规则文件 `~/.claude/remote-exec/rules.toml`（已存在则保留）—— 两个 agent 读同一份

不带 `--codex-home` 时按 `CODEX_HOME` 安装（本机 `.zshrc` 把它设成了 `~/.codex-midas`）。
注意本机 `~/.codex-midas/config.toml`、`~/.codex-seb/config.toml`、`~/.codex/config.toml`
实际是同一个文件（符号链接 + 硬链接），`skills/` 也是共享的；但 hooks.json 与信任 key 是
按 profile 区分的，所以每个 profile 都要装一次，信任条目会并存在那份共享 config.toml 里。

装完重启正在运行的 Claude Code / Codex 会话。卸载：`./uninstall.sh`
（同样支持 `--codex-home`；会删掉对应 profile 的信任条目，保留你自己的 `rules.toml`
和 `[features].hooks`）。

### Codex hook 的信任机制（关键）

Codex 会加载 hook，但在它处于 `untrusted` 状态时**静默跳过** —— 新写的 hooks.json 就是这个
状态，表现为「配置看起来对、hook 却从不执行」。信任记录持久化在 config.toml：

```toml
[hooks.state."/home/debian/.codex-seb/hooks.json:pre_tool_use:0:0"]
enabled = true
trusted_hash = "sha256:…"
```

key 和 hash 都由 Codex 自己算，所以 `install.sh` 不去猜：它通过 Codex 的 app-server
`hooks/list` RPC 读出本 profile 的 key 与 `currentHash`（`scripts/codex-trust-hook.py`），
写入信任条目，再查一次确认状态变成 `trusted`，失败就报警告。
hash 只覆盖 handler 命令行，不覆盖脚本内容 —— 改策略不需要重新信任，改 hook 路径才需要。

`[features].hooks = true` 也是必需的（旧名 `codex_hooks` 已废弃），安装器会补上。

### 两端执行层现状

| | Claude Code | Codex 0.154 |
|---|---|---|
| PreToolUse hook | **实测生效** | **实测生效**（信任记录写入后；`codex exec` 下可见 `hook: PreToolUse Blocked`，被拒命令不执行） |
| 第二层 | 无 | `rules/remote-exec.rules`：所有 `ssh`/`scp`/`sftp`/`rsync`/`ansible` 一律 `prompt`，作为粗粒度兜底 |

## 默认策略

- **safe**：远端只读命令；从远端往本地拷数据；写入只落在 `/tmp`、`/var/tmp`。判定看命令
  实际做什么，而不是看命令名：`ip addr show`、`timedatectl status`、`dpkg -l`、`crontab -l`、
  `docker compose ps` 都是只读形式，直接执行；这份只读形式清单是白名单，未识别的子命令或
  参数一律回落到 risky。
- **risky（需确认）**：临时目录以外的任何写入；往远端上传；service/unit 变更；包管理器；
  内核、网络、主机、用户、cron、容器运行时、存储配置变更；`curl … | sh`；
  以及一切读不确定的命令 —— **含糊即风险**。
- **deny（确认也不放行）**：`rm -rf /` 与系统目录递归删除、`mkfs`、`dd of=/dev/…`、
  `shutdown`/`reboot`、`chmod -R 777 /`、fork bomb。这些要用户自己去跑。

完整清单见 `skills/remote-exec/references/policy.md`。

## 扩展策略

编辑 `~/.claude/remote-exec/rules.toml`，reviewer 和 hook 会一起读它：

```toml
version = 1

[defaults]
ambiguous = "review"      # 含糊时的处理："review"（默认）| "deny"

[[rules]]
name   = "allow-log-reads"
action = "allow"              # allow | review | deny
match  = '^journalctl( |$)'   # 扩展正则，匹配远端命令文本
hosts  = ["prod-*"]           # 可选，对 ssh 别名做 glob；省略 = 所有 host
reason = "日志读取是只读操作"
```

求值顺序：内置 deny → 用户 `deny` → 用户 `review` → 用户 `allow` → 内置默认 →
`[defaults].ambiguous`。同一层内文件顺序即优先级。
**用户 `allow` 可以解掉内置的 risky，但永远解不掉内置的 deny。**
规则文件损坏或字段非法时，所有远端命令一律被拒 —— 不会 fail open。

用 `REMOTE_EXEC_RULES=<file>` 可以指向另一份规则文件（测试用）。

## 威胁模型（重要）

hook 是**失手拦截器，不是沙箱**。它确定性地拦下：没带审查判定的远端命令、
被标成 `safe` 但策略判定为 risky 的命令、deny 级命令（无论带什么标记）、
以及无法审查的 `ssh <host>` 交互式登录；另外它还拦下任何读取 `~/.ssh` 的 shell 命令。

它**无法证明** reviewer 真的跑过 —— 这部分依赖 skill 契约，和 `privileged-exec`
是同一信任模型。**「hook 没拦」永远不等于「已获批准」。**

## 已知缺口

- hook 只识别 `ssh` / `scp` / `sftp` / `rsync`。走 `docker -H ssh://`、远端 context 的
  `kubectl` 等其它通道到达远端的操作，hook 看不到（Codex 的 execpolicy 规则额外覆盖了
  `ansible`）。
- 不做 SSH 连接管理（`ControlMaster`、agent forwarding 等一概不碰）。
- 不写审计日志。
- 分类基于命令文本。远端展开的变量、拉取后执行的脚本、base64 载荷属于「读不出来」，
  按含糊处理（默认即 risky）。
- heredoc 正文按「数据」处理（否则写文档、写脚本时提一句 ssh 就会被拦）。唯一例外是
  `ssh host bash -s <<'EOF'`：这里正文就是远端命令，hook 会读出正文逐行判定，全是只读操作
  即 safe，不再每次要确认。但必须用引号标记 `<<'EOF'`——不加引号时正文会先在本地展开
  `$VAR` / `$(…)`，审过的文本不等于跑的文本；这种情况连同 `< file`、`cat x | ssh … bash -s`
  一律读不出来 → risky。
- 有界的 `for` 循环和 `if` 分支按循环体判定（迭代列表里的绝对路径照样参与写入判定）；
  `while` / `until`、以及把循环体扔到后台的 `for`（`do … & done`）一律 risky——
  表驱动分类器只看「跑什么」，不看「跑多少次」，只读操作重复无限次不再是只读。
  C 风格 `for ((i=0;i<3;i++))` 和 `case` 不识别 → risky（保守，不代表它们危险）。
- 引号里的散文若同时含管道符和 `ssh`（如 `python3 -c "print('| ssh a b |')"`）仍可能误报；
  误报可恢复，漏判不可恢复，所以保留这个偏保守的取舍。

## 测试

```bash
./tests/test_hook.sh         # 内置策略：标记语义、safe/risky/deny、包装与链式命令
./tests/test_rules.sh        # 用户规则：层级覆盖、host glob、坏文件不 fail open
./tests/test_codex_rules.sh  # Codex execpolicy 规则（未安装 codex 时自动跳过）
```
