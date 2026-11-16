/** GitLab project configuration, shared with the source settings panel. */
import type { Context } from '@deepseek-ai/cordis'
import type { z } from 'zod'
import { GitlabRepositorySchema } from '../deployment.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { pause, polled } from './poll.ts'
import { pollGitlabThread } from './gitlab-poll.ts'
import { sendGitlab } from './gitlab-channel.ts'
import type { Localized, SourceKind } from './kind.ts'

export type GitlabConfig = z.infer<typeof GitlabRepositorySchema>
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: 'gitlab',
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '自建 GitLab 仓库和合并请求配置。', en: 'Self-managed GitLab repository and merge request configuration.' },
  schema: GitlabRepositorySchema,
  fields: [
    { key: 'repository', type: 'text', label: { zh: '仓库 HTTPS 地址', en: 'Repository HTTPS URL' },
      hint: { zh: '填写项目仓库地址，不要包含账号或令牌。', en: 'Enter the project repository URL without credentials or tokens.' } },
    { key: 'baseBranch', type: 'text', label: { zh: '开发基准分支', en: 'Development base branch' },
      hint: { zh: '新工单的功能分支从此分支创建。', en: 'New Ticket branches start from this branch.' } },
    { key: 'targetBranch', type: 'text', label: { zh: 'MR 目标分支', en: 'Merge request target branch' },
      hint: { zh: '合并请求提交到此分支，可与开发基准分支不同。', en: 'Merge requests target this branch; it may differ from the development base.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '填写已单独登录智能体账号的 glab 包装脚本路径或命令名。', en: 'Command or wrapper path signed in with the dedicated agent account.' } },
  ],
  scope: () => ({ listened: true, observed: false, followupOnly: true }),
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_REPOSITORY', description: { zh: 'GitLab 仓库 HTTPS 地址', en: 'GitLab repository HTTPS URL' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体 GitLab 账号', en: 'Dedicated GitLab agent account' } },
      { key: 'DSH_SUPERAGENT_GITLAB_HOST', description: { zh: 'GitLab 实例地址', en: 'GitLab instance host' } },
      { key: 'DSH_SUPERAGENT_GITLAB_BASE', description: { zh: '此工单的开发基准分支', en: 'This Ticket development base branch' } },
      { key: 'DSH_SUPERAGENT_GITLAB_TARGET', description: { zh: '此工单的 MR 目标分支', en: 'This Ticket merge request target branch' } },
      { key: 'DSH_SUPERAGENT_GITLAB_BRANCH', description: { zh: '此工单唯一的功能分支', en: 'This Ticket feature branch' } },
      { key: 'DSH_SUPERAGENT_GITLAB_BASE_SHA', description: { zh: '此工单创建时固定的基准提交', en: 'The fixed base commit of this Ticket' } },
    ],
    values: ({ deployment }) => ({ DSH_SUPERAGENT_GITLAB_REPOSITORY: deployment.gitlab?.cloneUrl ?? '',
      DSH_SUPERAGENT_GITLAB_ACCOUNT: deployment.gitlab?.username ?? '', DSH_SUPERAGENT_GITLAB_HOST: deployment.gitlab?.host ?? '',
      DSH_SUPERAGENT_GITLAB_BASE: deployment.gitlab?.baseBranch ?? '', DSH_SUPERAGENT_GITLAB_TARGET: deployment.gitlab?.targetBranch ?? '',
      DSH_SUPERAGENT_GITLAB_BRANCH: '', DSH_SUPERAGENT_GITLAB_BASE_SHA: '' }),
  },
  health: ['gitlab'],
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab ? { cli: { zh: `当前账号 @${deployment.gitlab.username}`, en: `Current account @${deployment.gitlab.username}` } } : {},
}

export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register({ ...gitlabKind, channel: {
    send: (_host, message) => sendGitlab(sourceContext(ctx.orchestrator, gitlabKind), message),
    link: address => ({ url: address.url ?? '', label: { zh: `GitLab MR !${address.iid ?? ''}`, en: `GitLab MR !${address.iid ?? ''}` } }),
  } }), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  if (ctx.deployment.provider !== 'gitlab') { ctx.report('gitlab', health('paused', 'sourceOff')); return }
  while (!signal.aborted) {
    if (!ctx.config<GitlabConfig>('gitlab')) ctx.report('gitlab', health('paused', 'sourceOff'))
    else {
      const failures: string[] = []
      for (const thread of ctx.threads.subscribed('gitlab')) {
        if (signal.aborted || !ctx.config('gitlab')) break
        if (!polled(ctx, thread)) continue
        try { await pollGitlabThread(ctx, thread, signal); ctx.threads.patch(thread.key, { pollError: undefined }) }
        catch (error) {
          if (signal.aborted) break
          const detail = String(error)
          failures.push(`${thread.key}: ${detail}`)
          ctx.threads.patch(thread.key, { pollError: detail })
        }
      }
      if (!signal.aborted) ctx.report('gitlab', failures.length
        ? { state: 'error', detail: failures.join('; ') } : { state: 'ready', detail: 'Watching bound merge requests' })
    }
    await pause(60_000, signal)
  }
}
