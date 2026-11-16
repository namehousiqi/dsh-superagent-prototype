# dsh-superagent

> **本项目是仅供参考的研究原型，并非 DeepSeek 官方产品。** 这些代码源于团队日常开发工作，其中大量工程工作由编码智能体完成。请将其视为研究代码，而非可直接投入生产的软件。代码可能仍存在缺陷，编码风格和工程实践也可能不一致。在自己的环境中使用之前，请先审查并根据实际情况调整。
>
> 本项目经过了公开发布所需的调整，因此与内部版本及文章 *Exploring Super-agent Design: Towards a More Autonomous Agent System* 中描述的实现并不完全相同。文章讨论的部分设计是未来发展方向，尚未在此原型中实现。

dsh-superagent 是一个面向单个 GitHub 或自建 GitLab 仓库的主动式编码智能体，以 [DeepSeek Harness](https://www.deepseek.com/en/harness/) bundle 的形式提供。GitHub 部署监听 GitHub，并可选接入飞书；GitLab 部署从飞书接收请求并跟踪关联的合并请求。当获准的人员向智能体请求工作时，它会创建工作项，在独立的智能体 Session 和目录中执行，并在原对话中回复结果。Web 面板展示需要人工处理的事项。

它也是一种与智能体协作的方式：**尽量少占用人的注意力，尽量多创造价值。** 能够为整个团队行动的智能体也可能浪费整个团队的注意力，因此它只在有人请求或团队编写的规则允许时行动，只在有人必须采取行动或可以使用结果时发言。[000 理念](docs-zh/000-philosophy.md)解释了这一原则及其对操作人员的要求。

## 手动安装和启动

下面以 **GitLab + 飞书**为例，使用独立的 `superagent` 配置档案和本机 `3082` 端口。GitHub 仍是默认平台，GitHub 的账号和 worktree 配置见[部署指南](docs-zh/006-deployment.md)。本指南中的仓库地址、主机名、账号、分支和路径都需要替换成你自己的值，不预设业务仓库。

> 本项目是研究原型。Worker 以启动服务的操作系统用户身份运行，提示词和命令包装器不是安全沙箱。建议使用独立系统账号、独立 GitLab 账号及最小权限，并保护开发基准和 MR 目标分支。不要把令牌或应用密钥写进仓库地址、面板或聊天消息。

### 1. 准备环境和账号

- 安装 Node.js 22.19+ 或 24+、pnpm、Git 2.32+、Python 3.8+、tmux、DeepSeek Harness，以及 GitLab CLI `glab` 和飞书 CLI `lark-cli`。本项目的 pnpm 版本见 `package.json` 的 `packageManager`，Harness 版本要求见 `engines.dsh`。
- 在准备运行服务的机器和系统账号下，为 Harness 配好可用的模型提供商。模型凭据通过 Harness 的正常配置流程填写，不要写进本项目文件。
- 准备一个 GitLab 智能体账号，授予项目读取、推送工单功能分支和创建 MR 的权限；确认开发基准分支和 MR 目标分支已经存在。
- 在飞书开放平台创建、配置并发布具有机器人能力的应用，授予接收消息事件、读取和发送群消息以及读取群成员所需权限，并将机器人加入目标群。

可先在终端检查命令是否可用：

```sh
node --version
pnpm --version
git --version
python3 --version
tmux -V
dsh --version
glab --version
lark-cli --version
```

如果尚未安装 Harness，[部署指南](docs-zh/006-deployment.md)给出的公开版本安装命令为 `npm install -g @deepseek-ai/dsh@0.2.1-rc.3`；已有安装时先核对版本，避免覆盖现有环境。

### 2. 登录 GitLab 并配置飞书机器人

使用专用系统账号和智能体 GitLab 账号，在终端交互式登录；把 `gitlab.example.com` 换成你的 GitLab 主机名，端口非默认时按实际主机填写：

```sh
glab auth login --hostname gitlab.example.com --git-protocol https
glab auth status --hostname gitlab.example.com
```

登录凭据保存在 `glab` 的本机配置中；不要在命令参数中直接写令牌。若同一系统账号还使用个人 GitLab 凭据，应使用独立配置及专用 CLI 包装器，或改用独立系统账号。记录 `command -v glab` 的结果，稍后填入面板。

为飞书机器人创建独立的 `lark-cli` 配置。下面的密钥输入步骤使用 Bash，不会将密钥放入命令历史；将 `YOUR_APP_ID` 换成实际 app id：

```bash
read -r -s LARK_SECRET
printf '%s\n' "$LARK_SECRET" | LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id YOUR_APP_ID --app-secret-stdin
unset LARK_SECRET
LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
mkdir -p "$HOME/.local/bin"
```

执行 `read` 后在终端输入应用密钥并回车，输入不会回显。用文本编辑器创建 `~/.local/bin/lark-bot`，内容为：

```sh
#!/bin/sh
export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
exec lark-cli "$@"
```

```sh
chmod +x "$HOME/.local/bin/lark-bot"
"$HOME/.local/bin/lark-bot" auth status
"$HOME/.local/bin/lark-bot" config strict-mode
```

确认机器人身份为 `ready`，严格模式为 `bot`。面板中使用该包装器的**绝对路径**。不要删除共享钥匙串条目；有关配置隔离的说明见[飞书账号配置](docs-zh/006-deployment.md#飞书机器人可选)。

### 3. 构建并安装到独立配置档案

以下命令从**本项目检出目录**执行。若尚未下载本项目，先克隆本项目仓库并进入目录；这里不是要求克隆待开发的 GitLab 业务仓库。

```sh
pnpm install
pnpm build
```

**仅在确认 `superagent` 配置档案不存在时**，创建档案并安装本目录的 bundle：

```sh
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

该创建命令会替换同名已有配置档案并删除其 `cordis.patch.yml`。如果档案已经存在，跳过创建命令，先备份并按[升级说明](docs-zh/006-deployment.md#升级)处理，不要覆盖已有配置。

### 4. 设置状态目录并启用飞书

对于刚创建、尚无自定义配置的档案，可从示例开始：

```sh
cp examples/profile.cordis.patch.yml "${DSH_HOME:-$HOME/.dsh}/profiles/superagent/cordis.patch.yml"
```

**该命令会覆盖目标文件**；如果已有自定义配置，应改为手动合并以下条目，勿直接复制覆盖。编辑目标文件，将 `stateDir` 换成当前系统账号有读写权限的**绝对路径**，并启用飞书，例如：

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 3082
- id: dsh-superagent
  config:
    stateDir: /home/your-user/.dsh/state/superagent
- id: dsh-superagent-feishu
  disabled: false
```

YAML 中的 `/home/your-user/...` 只是示例，必须替换为实际绝对路径；不要直接使用 `~`。已有配置档案还需保留文件中的其他必要条目。默认只监听本机；不要直接暴露到公网。

### 5. 启动并在面板完成设置

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

首次启动尚未设置仓库时，服务可能已运行但状态码为 `3`（等待设置），这是预期状态。打开启动日志中打印的 URL（默认本机地址为 `http://127.0.0.1:3082`），在侧边栏打开 **Superagent**。使用非默认端口时，脚本也要传入相应地址，例如 `scripts/dsh-superagent --url http://127.0.0.1:3083 status`。

按以下顺序保存；更改账号或选择平台可能触发服务重启，等面板恢复后再进行下一步：

1. **设置 → 来源 → GitLab**：启用来源，填写不含凭据的仓库 HTTPS 地址、已存在的开发基准分支、已存在的 MR 目标分支，以及智能体的 `glab` 命令或绝对路径。两个分支可以不同。
2. **设置 → 执行**：将仓库平台选择为 **GitLab** 并保存。GitLab 工单由宿主自动克隆和创建功能分支，不使用 GitHub 的准备命令。
3. **设置 → 来源 → 飞书**：启用来源，填写 `lark-bot` 的绝对路径，配置机器人已加入的群、接收提及或全部消息，以及是否接收私信。
4. **设置 → Policy**：添加允许请求工作的飞书用户，或配置群成员同步；按团队需要调整规则。确认 Harness 使用的模型可用。
5. 再次运行 `scripts/dsh-superagent status`，查看设置问题和健康状态。状态码 `0` 为正常、`2` 表示某组件报错、`3` 表示等待设置、`1` 表示未运行、重复实例、无响应或运行时错误。

设置检查只验证项目和分支的读取，不会通过写入远端预先验证推送及创建 MR 的权限；写权限不足会在发布时报告。

### 6. 试用、停止和重启

从允许名单中的飞书账号，在已配置的群里提及机器人并发送开发请求。面板出现工单后，可查看 Worker 的工作和关联 MR。功能分支从配置的开发基准分支创建，MR 指向配置的目标分支；MR 由人审核和合并。关联评论、当前提交的 CI 及合并或关闭状态会被跟踪。

```sh
scripts/dsh-superagent status
scripts/dsh-superagent stop
scripts/dsh-superagent start
scripts/dsh-superagent restart
```

这些命令从本项目目录运行。服务日志位于本项目 `.artifacts/`；停止和重启会等待优雅关闭，不会强制终止 Worker。更换仓库或平台前需要关闭所有进行中的工单。更多配置、升级和故障排查见[部署指南](docs-zh/006-deployment.md)。

### 智能体辅助设置

[SETUP.md](SETUP.md) 提供 GitHub 部署的智能体辅助流程；它目前不包含上述 GitLab 手动配置步骤。

## 文档

请按编号顺序阅读；每篇文档只依赖之前的文档。

- [000 理念](docs-zh/000-philosophy.md)
- [001 领域模型](docs-zh/001-domain.md)
- [002 授权](docs-zh/002-authorization.md)
- [003 执行](docs-zh/003-execution.md)
- [004 提示词](docs-zh/004-prompts.md)
- [005 面板](docs-zh/005-panel.md)
- [006 部署](docs-zh/006-deployment.md)：手动安装、配置、升级和故障排查
- [007 架构](docs-zh/007-architecture.md)
- [008 扩展指南](docs-zh/008-cookbook.md)：添加 Source

## 开发

`pnpm check` 依次运行类型检查、测试和构建。

## 许可证

[MIT](LICENSE)
