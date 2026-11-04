# 006 部署

本指南介绍 dsh-superagent 的安装、配置与运维，涵盖账号、启动检查、升级和故障排查，建立在 [001 领域模型](001-domain.md)至 [005 面板](005-panel.md)之上。

## 运行内容

- **专用 DeepSeek Harness 配置档案**，本指南称为 `superagent`。从 Web 配置档案模板创建，加载 bundle 并在 `127.0.0.1` 提供面板。应与日常使用的配置档案分开：插件会改变进程级 `PATH` 和 git 设置，其进程需要独立重启和升级。
- **智能体 GitHub 账号。** 智能体通过仅登录该账号的 GitHub CLI，以此身份评论、推送分支及创建拉取请求。
- **可选：** 用于接收聊天请求的飞书机器人。

插件配置保存状态目录和机器限制。其他配置使用面板：来源中设置仓库和账号，Policy 中设置允许名单，执行中设置 Worker 目录和命令。

### 权限和隔离

bundle 为 Executor 定义 `dsh-superagent-worker`，为主 Session 定义 `dsh-superagent-router`。它们会出现在 DeepSeek Harness 预设列表中，但仅供 dsh-superagent 使用。不要为个人 Session 选择它们，也不要禁用其配置项；应用需要它们来创建和恢复 Session。

在 Web UI 中打开空白受管 Session 可能选择配置档案的默认预设。dsh-superagent 在第一轮前恢复角色专属预设。

两个预设都以操作人员的操作系统用户身份、使用 `danger-full-access` 运行，并读取订阅 Thread 的消息。账号包装器默认选择智能体凭据，但不隔离进程。Worker 可按路径执行程序并读取操作人员的主目录。需要隔离时，请使用仅包含智能体凭据的专用操作系统账号。

## 前置条件

- Node.js 22.19+ 或 24+、pnpm、git 2.32+、Python 3.8+ 和 tmux。
- GitHub CLI（`gh`）2.48 或更高版本。Source 的 CLI 字段必须指向 `gh` 或 `lark-cli` 包装器；宿主依赖其子命令和输出格式。
- github.com 上的仓库；不支持 GitHub Enterprise Server。要为每个 Ticket 创建检出，请保留本地克隆供准备命令添加 worktree。仓库使用 Git LFS 时安装 `git-lfs`。
- DeepSeek Harness 已配置模型提供商。除非 Eval 或 Execution 设置指定其他模型，dsh-superagent 使用配置档案的默认模型。
- 使用飞书时：`lark-cli`（已用 1.0.90 测试）以及具备机器人能力的飞书或 Lark 应用。

## 账号

### 智能体 GitHub 账号

1. 为智能体创建 GitHub 用户账号并授予仓库写入权限。GitHub App 不能作为智能体，因为 dsh-superagent 需要读取账号通知。
2. 为其提供只使用该账号凭据的 GitHub CLI：

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   以智能体账号登录；最后一条命令打印其登录名。dsh-superagent 以相同方式读取登录名。

### 飞书机器人（可选）

1. 创建具备机器人能力的自建应用。授予接收消息事件、读取和发送群消息以及读取群成员的权限，然后发布应用版本。
2. 为机器人创建只允许机器人身份的独立 `lark-cli` 配置和包装器：

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   第一条命令从标准输入读取应用密钥。使用独立配置目录：`lark-cli` 每个 app id 只允许一个配置档案，个人配置中可能已有该应用的用户登录。

   宿主会拒绝能够以用户身份操作的 CLI。它从机器人配置读取 app id、飞书/Lark 品牌和机器人 `open_id`。

   两份配置共享应用密钥的钥匙串条目。若只删除机器人配置，请删除其目录；不要运行 `lark-cli config remove`，因为它会影响共享密钥。

## 安装

在尚无 `superagent` 配置档案的机器上运行一次：

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

上述固定版本为公开版本；其他版本必须满足 `package.json` 中的 `engines.dsh`。

第四条命令从 DeepSeek Harness Web 模板创建 `~/.dsh/profiles/superagent`。第五条命令安装此 bundle。可设置 `DSH_HOME` 更改默认的 `~/.dsh` 目录位置。

仅在新安装时运行创建配置档案的命令。如果配置档案已存在，该命令会替换它并删除其 `cordis.patch.yml`，包括机器配置。升级时不要使用该命令。

## 机器配置

将 [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) 复制到 `~/.dsh/profiles/superagent/cordis.patch.yml`，替换该文件，并替换每个 `<placeholder>`。使用飞书时，还须启用其中的 `dsh-superagent-feishu` 项。`webserver` 项设置面板端口。

| 键 | 必需 | 含义 |
| --- | --- | --- |
| `stateDir` | 是 | 绝对路径：数据库、锁、`worker-bin` 中的命令 shim、智能体 git 配置，以及默认情况下 `work` 中的 Ticket 目录。升级前请备份 |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | 否 | 已保存提示词配置的最大长度，以及一次研判在指定时间内最多读取的 Thread 页数 |

首次启动后，在**设置 → 部署**或 DeepSeek Harness 插件管理器中编辑机器限制。更改无需重启即可生效。`stateDir` 不能在那里修改。无效值或未知配置键会阻止启动；日志会指出该键。

## 启动和停止

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`start` 在 tmux 会话 `dsh-superagent` 中运行 `dsh --profile superagent`，其他配置档案使用 `dsh-<profile>`。它最多等待一分钟，直到运行时就绪或报告设置要求。首次运行时会打印缺少的设置信息。它拒绝重复实例，包括在脚本外启动的实例。

`stop` 和 `restart` 请求优雅关闭，并最多等待 Executor 五分钟。它们绝不强制终止进程，也不触碰其他 tmux 会话。

`status` 打印进程 id、健康状态和设置问题。使用其他配置档案或端口时，使用 `--profile` 和 `--url`，或设置 `DSH_SUPERAGENT_PROFILE` 和 `DSH_SUPERAGENT_URL`。

`status`、`start` 和 `restart` 的退出码有四种：

| 退出码 | 含义 |
| --- | --- |
| 0 | 服务正常运行 |
| 1 | 未运行、重复运行、无响应或运行时报告错误；重启可能修复 |
| 2 | 服务运行中，但运行时以外的组件（如 Source 或 Policy 同步 `sync:<source id>`）报告错误；重启不能修复 |
| 3 | 服务运行中，等待设置；重启不能修复 |

仍在启动的 Source 视为正常运行。设置流程无法检查的飞书机器人也视为正常。

`status` 在 `errors` 下返回失败组件及详情，在 `setup` 下返回设置要求。`start` 和 `restart` 逐行打印这些问题；服务始终未启动时退出码为 1。只有主动执行 `stop` 才会暂停自动恢复。

每个配置档案在 `.artifacts/` 下保存日志和控制文件：

- 启动日志：`dsh-superagent-<profile>-<date>-<time>-<pid>.log`，其中 pid 属于脚本。保留最新 20 个。
- 控制文件：`control/profiles/<profile>/`，包含停止标记、锁和进程 id。

打开日志中打印的 URL，然后在侧边栏选择 **Superagent**。

### 每小时检查

在平时使用的 DeepSeek Harness 配置档案中创建每小时检查，而不是在 `superagent` 中创建。智能体服务停止时它必须继续运行。请该配置档案中的智能体使用以下提示词创建每小时计划，并填入检出路径：

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` 保留主动停止。只有 `stop` 写入标记；`start` 清除标记。`restart` 不写标记，因此检查可以恢复关闭超时的重启。

## 设置

设置必须成功后才开始轮询或工作。概览列出缺少的要求并链接到对应设置。设置变更会再次运行设置检查。如果修复了应用外部的问题，如 CLI 认证，请选择**重新检查**。

1. **来源。** 设置 GitHub 仓库（`owner/name`）和智能体 CLI，例如 `/home/me/.local/bin/gh-agent`。请求通常通过智能体账号的通知到达。提及该账号的新 Issue 或评论在下一次轮询时到达；通过编辑已有 Issue 正文新增提及则不会到达，请改发新评论。使用飞书时设置机器人 CLI、群、每个群的接收全部或仅接收提及模式，以及是否接收私信。
2. **Policy。** 两条示例规则可以编辑或删除。在**各来源**中添加可请求工作的 GitHub 账号和飞书用户；名单中没有人时，请求无法成为 Ticket。使用飞书时可选择一个群，在启动时和点击**立即同步**时从其同步名单。
3. **执行。** 设置目录根路径和准备命令。为每个 Ticket 创建仓库检出：

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   将个人 CLI（例如登录了个人账号的 CLI）列为禁止命令。
4. **提示词。** 设置团队部分：GitHub 身份披露行、评审机器人、提交作者和自动合并条件。

### 管理 API

面板使用本地 HTTP API，智能体也可以调用。`SETUP.md` 使用它保存设置，服务脚本读取 `GET state`。

向 `http://127.0.0.1:<port>/orchestrator/api/` 发送请求，附带 `x-orchestrator-request: 1`。Host 必须为 `127.0.0.1:<port>` 或 `localhost:<port>`。缺少请求头或 `Origin` 来自其他站点时返回 403。

API 保存具有面板权限，可以修改执行环境和设置账号字段，而通过主 Session 工具保存则不能。

智能体可以依赖以下路由和字段。`src/app/api.ts` 中其他路由供面板使用，随面板变化。

| 请求 | 返回 |
| --- | --- |
| `GET state` | 各页面读取的状态：`setup` 含 `problem` 和 `feishuProblem`，每项为 `null` 或包含 `place`、`code`、`values`、`detail` 的设置问题，设置解析账号后还有 `accounts`；`health` 为下述每个组件的健康项，包含 `state`（`starting`、`ready`、`paused` 或 `error`）、`detail`、`at`；`load` 含运行中的 Executor Session 数 `running`、排队 Ticket 数 `queued`、`maxWorkers`；另有 `paused` 和 `masterId` |
| `GET settings` | `blocks`：`policy`、`eval`、`executor`，各含 `value` 和 `revision`；`sources`：Source 实例，各含 `id`、`kind`、`installed`、其配置块 `value`（`{"enabled": …, "config": {…}}`）、`revision`、kind 表单和可能存在的设置 `problem`；以及 `policyVersion` 和执行环境的 `root`、`variables` |
| `GET sources` | 每个 Source 的状态：`state`（`missing`、`off`、`error`、`setup`、`starting`、`paused` 或 `ready`）、组件 `health`、设置 `problem`、过去一天的 `stats`、该日 `filtered` Trigger 和 `dropped` 消息。丢弃消息按最新优先，含 `channel`、`preview`、有 Ticket 时的 `ticket`（`id` 和 `title`）、存储中存在时的 `thread`，以及 `dropped.at` 和 `dropped.reason`（`channelGone` 或 `channelIgnored`） |
| `PUT settings/<block>`，正文 `{"value": …, "revision": n}` | 保存一个块，返回 `saved`、块的新 `revision`、`policy_changed` 和 `restarting`。`value` 是 `GET settings` 中的整个块；缺失键使用默认值 |
| `POST executor/pause`，正文 `{"paused": true}` 或 `false` | 暂停或恢复处理，返回 `paused` |
| `POST setup/check` | 通过重启 dsh-superagent 再次运行设置，返回 `restarting: true`。没有需要修复的设置问题时拒绝 |
| `POST policy-sync/<source id>` | 立即同步该 Source 的允许名单，返回已保存的 Source Policy 部分 `policy` |
| `GET prompts`、`PUT prompts`，正文 `{"config", "baseRevision"}` | 读取提示词配置：`current` 含 `revision` 和 `config`，还有 `defaults`、按 Session 读取顺序排列的团队 `sections`、团队技能名称模式 `skillName`、不可使用的内置名称 `builtin`、Session 加载技能名时使用的 `skillPrefix`；保存时返回新 `revision` |
| `POST tickets/<id>/retry`、`POST tickets/<id>/stop` | 与面板一样重试或停止 Ticket |

健康项按职责分组：

| 项 | 报告内容 |
| --- | --- |
| `runtime` | 应用本身 |
| `models` | 等待模型预算重试的 Session |
| `evals` | 过去一小时中没有后续判断或忽略的 unavailable Eval |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply` | [003 执行](003-execution.md)中描述的已保存工作；delivery 统计等待工作，reply 涵盖 Channel 消息 |
| `worker` | Executor Session 事件处理；首次失败后出现 |
| `github`, `feishu`, `history` | Source 轮询、事件和历史恢复 |
| `sync:<source id>` | 允许名单同步 |

拒绝响应包含状态码和英文 `error` 文本：

- 400：无效值（`issues`，每项含 `path`）、账号检查失败（`setup`）、固定拒绝（`code` 和 `values`），或正文不是 JSON 或过大。
- 404：对象不存在。
- 409：修订版本过期。
- 500：其他情况。

配置块：

- `source:github`、`source:feishu`：`{"enabled": true, "config": {…}}`。GitHub 配置包含 `repository`、`cli`，以及默认关闭的 `observeIssues`、`observePulls`、`observeComments`、`observeCi` 开关，用于接收仓库中的全部新 Issue、新拉取请求和评论以及默认分支 CI；飞书配置包含 `cli`、格式为 `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]`（或 `"all"`）的 `chats`、`directMessages`，以及值为 `"none"` 或 `"mentions"` 的 `otherChats`。
- `policy`：`{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`。`bots` 列出消息可成为推断候选的机器人。飞书 `admission` 行以群 id、`other` 或 `direct` 为键，GitHub 使用 `issues`、`pulls`、`comments` 或 `ci`；未设置的单元格使用默认值（见 [002 授权](002-authorization.md)）。
- `eval`：`mode`、`timeoutSeconds` 和 `model`。
- `executor`：`model`、`maxWorkers`、`directory`、`prepare` 和 `blockedCommands`。处理暂停是独立设置 `paused`，由 `POST executor/pause` 设置。

更改仓库或 CLI 会先运行对应设置检查。检查失败返回 400，详情在 `setup` 中。成功更改账号，或设置待完成期间的任何保存，都会返回 `restarting: true`。应用重启期间 API 暂时不可用。

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## 设置检查

设置流程像 Worker shell 一样使用 DeepSeek Harness 子进程服务。它会移除名称包含 KEY、PASSWORD、SECRET 或 TOKEN 的环境变量。

设置检查 GitHub 仓库及智能体的推送权限，写入 Worker 环境，并检查 git 对 github.com 只使用智能体凭据。飞书设置失败只会禁用飞书 Source。

设置写入的进程环境：

- `<stateDir>/worker-bin` 中的**命令 shim** 位于 `PATH` 首位：`gh` 运行智能体 CLI；`lark-cli` 运行机器人 CLI；禁止的命令失败。shim 运行目标前会从 `PATH` 移除自身目录。
- `<stateDir>/worker-gitconfig` 中的 **git 配置**替换操作人员的全局和系统 git 配置。它选择智能体 CLI 作为 github.com 凭据助手，将 GitHub SSH 地址重写为 HTTPS，并定义 Git LFS 过滤器。HTTP 代理等个人 git 设置不生效。这里不设置提交身份；git 绝不提示输入凭据；`GH_TOKEN` 和 `GITHUB_TOKEN` 被移除。

如果 `worker-bin` 或 `worker-gitconfig` 中存在非 dsh-superagent 写入的文件，设置会停止。位于某个 git 仓库内部的 Ticket 目录，若该仓库自身配置添加了凭据，则 Ticket 失败。

## 尝试使用

使用允许名单中的 GitHub 账号创建 Issue，或发布包含 `@<agent login> <request>` 的评论。在一个轮询间隔内（默认一分钟），概览应显示 Ticket。智能体确认请求，在自己的 Session 和目录中工作，并在原对话中交付。使用飞书时，在配置的群中提及机器人。

## 升级

1. 等待所有 Executor 均不在轮次中间。
2. 备份 `<stateDir>/orchestrator.sqlite`。
3. 运行 `git pull && pnpm install && pnpm build`。
4. 运行 `scripts/dsh-superagent restart` 并检查状态。

重启会结束运行中的 Assignment，并以恢复说明启动替代 Assignment。团队文本和覆盖的提示词部分会保留；没有覆盖项的部分跟随新默认值。升级后检查标记为**默认内容已更新**的部分。

由新版本迁移过的数据库不能被旧版本打开，因此回滚需要升级前备份。升级 DeepSeek Harness 本身后，重启运行中的实例，使面板加载匹配的构建产物。

### 智能体预设

Worker 和 router 预设在 5 秒后将 shell 命令转入后台。Session 没有其预设时无法加载。当 Session 仍在使用时，请保留 `cordis.patch.yml` 中的 `dsh-superagent-worker` 和 `dsh-superagent-router` 项，否则恢复会以 `agent-preset/not-found` 失败。

## 故障排查

设置问题在概览中以面板语言显示，并附修复链接；日志和 API 显示下列英文文本。

| 现象 | 原因和修复 |
| --- | --- |
| `The agent GitHub CLI is not set.` | 在 GitHub 卡片上设置智能体 CLI |
| `The agent GitHub CLI was not found.` | 设置包装器绝对路径，或 `PATH` 中的命令名称 |
| `The agent GitHub CLI cannot read its account` | 使用 `auth login` 登录包装器 |
| `@… cannot read …` 或 `@… cannot push to …` | 授予智能体账号仓库写权限 |
| `The GitHub Source names no repository.` | 在 GitHub 卡片上设置仓库 `owner/name` |
| Ticket 以 `The prepare command failed: …` 失败 | 输出指出原因，例如克隆路径错误；修复命令后重试 Ticket |
| `git does not read the github.com credential configuration dsh-superagent writes` | 安装 git 2.32 或更高版本 |
| Ticket 以 `The git configuration of the repository in … sets …` 失败 | 从克隆的 `.git/config` 移除指出的凭据或 `http.*.extraheader` 设置 |
| `… was not written by dsh-superagent` | 将指出的文件移出 `<stateDir>/worker-bin` 或 `<stateDir>/worker-gitconfig`，或选择另一个 `stateDir` |
| `The bot lark-cli allows user identities` | 按上文飞书机器人说明，将飞书 Source 指向仅机器人配置 |
| `The bot lark-cli does not work.` 或 `The bot identity of app … is …` | 检查配置中的 app id 和密钥 |
| `The Feishu bot is not a member of the chat.` | 在群设置中将机器人加入群，下次尝试会成功 |
| `status` 退出码为 2 | 某组件报告重启无法修复的错误；`errors` 列出管理 API 一节所列组件及详情。各组件恢复后清除自己的条目 |
| `status` 退出码为 3 | 等待设置；`setup` 说明缺少什么，概览链接到可修复它的设置 |
| `status` 退出码为 1 | 服务未运行、重复运行、无响应或运行时报告错误；输出和最新日志说明具体原因 |
| `… timed out after 90 s`、`… was stopped by …`、`… exited with code …` 或 `… could not run: …` | CLI 失败但未打印原因；以操作人员用户手动运行指出的程序，查看其自身消息 |
| 面板显示 dsh-superagent 无响应 | 它正在重启，或因配置未能启动；DeepSeek Harness 日志会指出原因 |
| 日志中出现 `dsh-superagent configuration has keys it does not use` | 移除指出的键；消息会说明各值现在位于何处 |
| 日志显示插件与运行中的 dsh 不兼容 | 安装符合 `engines.dsh` 范围的 DeepSeek Harness 版本 |
| 升级 DeepSeek Harness 后面板显示 “Failed to load plugins” | 重启运行中的实例 |
| 提及后没有任何反应 | 检查作者是否在 Source 的允许名单上、Source 是否开启以及处理是否暂停。GitHub 上通过编辑 Issue 正文新增的提及不会被接收；请在评论中提及智能体 |
