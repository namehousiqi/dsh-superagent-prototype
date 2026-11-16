# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub or self-managed GitLab repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). GitHub deployments listen to GitHub and optionally Feishu; GitLab deployments take requests from Feishu and follow their associated merge requests. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation with the result. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Manual installation and startup

**[中文手动安装与启动手册](README.zh-CN.md#手动安装和启动)** includes the full GitLab and Feishu setup. The steps below use a dedicated `superagent` profile, local port `3082`, and GitLab with Feishu. For GitHub-specific setup, see the [deployment guide](docs/006-deployment.md).

This is a research prototype. Workers run as the operating-system user that starts the service; prompts and CLI wrappers are not a sandbox. Use a dedicated OS account, a dedicated GitLab account with minimum permissions, and protected base and target branches. Never put credentials in repository URLs, panel settings, or chat messages.

### Prerequisites and accounts

Install Node.js 22.19+ or 24+, pnpm, Git 2.32+, Python 3.8+, tmux, DeepSeek Harness, `glab`, and `lark-cli`. See `packageManager` and `engines.dsh` in [package.json](package.json) for compatible versions. Configure an available model provider in Harness. If Harness is not installed, the [deployment guide](docs/006-deployment.md) lists the public version install command `npm install -g @deepseek-ai/dsh@0.2.1-rc.3`.

Grant the dedicated GitLab account project read access and permission to push Ticket branches and create merge requests. Both the development base branch and MR target branch must already exist. Sign in interactively as that account, replacing the host below with your own:

```sh
glab auth login --hostname gitlab.example.com --git-protocol https
glab auth status --hostname gitlab.example.com
```

Do not pass a token on the command line. Use a dedicated OS account or an isolated CLI configuration and wrapper if personal credentials also exist. Note the result of `command -v glab` for the panel.

Create and publish a Feishu application with bot access and the necessary message and group-member permissions, and add it to the target group. Configure a separate bot-only `lark-cli` and wrapper using the [Feishu account instructions](docs/006-deployment.md#feishu-bot-optional); the [Chinese manual](README.zh-CN.md#2-登录-gitlab-并配置飞书机器人) also gives the terminal steps. Never paste the app secret into chat or a configuration file in this repository.

### Build and install

Run the following in this project's checkout. If necessary, clone **this project** first; it is not the GitLab business repository the agent will work on.

```sh
pnpm install
pnpm build
```

**Only when the `superagent` profile does not already exist**, create it and install this checkout as a bundle:

```sh
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

The profile creation command replaces an existing profile of the same name and deletes its `cordis.patch.yml`. For an existing profile, skip creation, back it up, and follow the [upgrade instructions](docs/006-deployment.md#upgrade).

For a newly created profile without custom configuration, copy the example:

```sh
cp examples/profile.cordis.patch.yml "${DSH_HOME:-$HOME/.dsh}/profiles/superagent/cordis.patch.yml"
```

**This overwrites the destination.** For a profile with existing customization, merge the entries by hand instead. Edit the file, replace `stateDir` with a writable **absolute path**, and enable Feishu. Keep any other required existing entries:

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

Replace the example path with your own; do not use `~` in YAML. Keep the server bound to localhost rather than exposing it directly to the internet.

### Start and configure

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

On the first start, exit code `3` means the service is running and waiting for setup. Open the URL printed in the startup log (by default `http://127.0.0.1:3082`) and select **Superagent** in the sidebar. Save settings in this order, waiting for the panel to return if a save restarts the service:

1. Under **Settings → Sources → GitLab**, enable the source and enter your credential-free HTTPS repository URL, development base branch, MR target branch, and agent `glab` command or absolute path. The branches may differ; no repository or branch is prefilled.
2. Under **Settings → Execution**, choose **GitLab** as the repository source. GitLab workspaces are cloned and branched by the host; the GitHub prepare command is not used.
3. Under **Settings → Sources → Feishu**, enable the source, enter the absolute path of the bot-only CLI wrapper, and configure groups and message reception.
4. Under **Settings → Policy**, add allowed Feishu requesters or configure group-member synchronization. Adjust rules as needed, and confirm the model is available.
5. Run `scripts/dsh-superagent status` again. Exit `0` means healthy, `2` a component error, `3` setup pending, and `1` stopped, duplicated, unreachable, or a runtime error.

Setup checks project and branch reads but does not push or create an MR to prove write permissions. Publication reports permission failures when attempted.

### Use and operate

From an allowed Feishu account, mention the bot in a configured group and send a development request. The host creates a Ticket branch from the configured base and publishes an MR against the target. People review and merge the MR; the host follows its comments, matching-head CI, and merged/closed state.

```sh
scripts/dsh-superagent status
scripts/dsh-superagent stop
scripts/dsh-superagent start
scripts/dsh-superagent restart
```

Run these from the project directory. Logs are under `.artifacts/`; stop and restart wait for graceful shutdown without force-killing workers. Close all open Tickets before changing repository or provider. For a non-default port, pass the matching `--url`, for example `scripts/dsh-superagent --url http://127.0.0.1:3083 status`. See the [deployment guide](docs/006-deployment.md) for upgrades and troubleshooting.

### Agent-assisted setup

[SETUP.md](SETUP.md) describes an agent-assisted **GitHub** setup; it does not yet cover the GitLab manual setup above.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
