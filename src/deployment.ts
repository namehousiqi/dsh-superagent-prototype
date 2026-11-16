/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const GitlabRepositorySchema = z.object({
  repository: z.string().trim().default(''),
  baseBranch: z.string().trim().default(''),
  targetBranch: z.string().trim().default(''),
  cli: z.string().trim().default(''),
}).strict()
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = {
  github: Object.keys(GithubAccountsSchema.shape), gitlab: Object.keys(GitlabRepositorySchema.shape), feishu: Object.keys(FeishuBotSchema.shape),
}

export interface GitHubAgent { cli: string; login: string; noreply: string }
export interface GitLabProject {
  cli: string
  host: string
  projectId: number
  repository: string
  webUrl: string
  cloneUrl: string
  username: string
  baseBranch: string
  targetBranch: string
}
export interface Deployment extends Machine {
  provider: 'github' | 'gitlab'
  repository: string
  github?: GitHubAgent
  gitlab?: GitLabProject
  feishu?: FeishuBot
}
export interface GithubDeployment extends Deployment { provider: 'github'; github: GitHubAgent }
export interface GitlabDeployment extends Deployment { provider: 'gitlab'; gitlab: GitLabProject }
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }

/** Reject GitHub operations when the instance uses another repository provider. */
export function githubAgent(deployment: Pick<Deployment, 'github'>): GitHubAgent {
  if (!deployment.github) throw new Error('GitHub is not the selected repository provider')
  return deployment.github
}
/** Reject GitLab operations when the instance uses another repository provider. */
export function gitlabProject(deployment: Pick<Deployment, 'gitlab'>): GitLabProject {
  if (!deployment.gitlab) throw new Error('GitLab is not the selected repository provider')
  return deployment.gitlab
}

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<GithubDeployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, provider: 'github', repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

const GitLabUser = z.object({ username: z.string().min(1), id: z.number().int().positive() })
const GitLabProjectResponse = z.object({ id: z.number().int().positive(), path_with_namespace: z.string().min(3), web_url: z.string().url(),
  http_url_to_repo: z.string().url(), default_branch: z.string().min(1).nullish(), can_create_merge_request_in: z.boolean().optional() })
const GitLabBranch = z.object({ name: z.string().min(1) })
/** Parse a project URL without accepting embedded credentials, non-HTTPS protocols or web-page paths. */
export function parseGitLabRepository(value: string): { host: string; path: string } {
  let url: URL
  try { url = new URL(value) } catch { throw new SetupError('gitlabRepositoryInvalid') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new SetupError('gitlabRepositoryInvalid')
  const path = url.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '').replace(/^\//, '')
  const parts = path.split('/')
  if (parts.length < 2 || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..' || part === '-')) {
    throw new SetupError('gitlabRepositoryInvalid')
  }
  return { host: url.host, path }
}
/** Resolve a self-managed GitLab project, identity, and explicitly configured development/merge target branches. */
export async function resolveGitLab(machine: Machine, input: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<GitlabDeployment> {
  const config = GitlabRepositorySchema.parse(input ?? {})
  if (!config.repository) throw new SetupError('gitlabRepositoryUnset')
  if (!config.cli) throw new SetupError('gitlabCliUnset')
  if (!config.baseBranch || !config.targetBranch) throw new SetupError('gitlabBranchesUnset')
  const wanted = parseGitLabRepository(config.repository)
  let cli: string
  try { cli = executable(config.cli, path, workerBin(machine.stateDir)) } catch (error) { throw new SetupError('gitlabCliMissing', { output: reason(error) }) }
  const invoke = (endpoint: string) => probe([cli, 'api', endpoint, '--hostname', wanted.host])
  // Do not echo CLI stderr, which may contain authentication material from a misconfigured wrapper.
  const failed = (error: unknown): never => {
    const status = /\bHTTP\s+(\d{3})\b|\b(\d{3})\s+Not Found\b/i.exec(reason(error))
    throw new SetupError('gitlabCliFailed', status ? { output: `HTTP ${status[1] ?? status[2]}` } : {})
  }
  const account = parsed(GitLabUser, await invoke('/user').catch(failed))
  if (!account) throw new SetupError('gitlabCliSignedOut')
  const project = parsed(GitLabProjectResponse, await invoke(`/projects/${encodeURIComponent(wanted.path)}`).catch(failed))
  if (!project) throw new SetupError('gitlabRepositoryUnreadable', { repository: config.repository })
  const canonical = { host: wanted.host, path: project.path_with_namespace.toLowerCase() }
  const matches = (value: string): boolean => {
    try {
      const got = parseGitLabRepository(value)
      return got.host === canonical.host && got.path.toLowerCase() === canonical.path
    } catch { return false }
  }
  if (wanted.path.toLowerCase() !== canonical.path || !matches(project.web_url) || !matches(project.http_url_to_repo)) {
    throw new SetupError('gitlabRepositoryMismatch')
  }
  if (project.can_create_merge_request_in === false) throw new SetupError('gitlabMergeRequestForbidden')
  const branch = async (name: string, missing: 'gitlabBaseBranchMissing' | 'gitlabTargetBranchMissing'): Promise<void> => {
    const result = await invoke(`/projects/${project.id}/repository/branches/${encodeURIComponent(name)}`).catch((error: unknown) => {
      if (/\bHTTP\s+404\b|\b404\s+Not Found\b/i.test(reason(error))) throw new SetupError(missing, { branch: name })
      return failed(error)
    })
    const found = parsed(GitLabBranch, result)
    if (!found || found.name !== name) throw new SetupError(missing, { branch: name })
  }
  await branch(config.baseBranch, 'gitlabBaseBranchMissing')
  if (config.targetBranch !== config.baseBranch) await branch(config.targetBranch, 'gitlabTargetBranchMissing')
  return { ...machine, provider: 'gitlab', repository: project.path_with_namespace,
    gitlab: { cli, host: wanted.host, projectId: project.id, repository: project.path_with_namespace, webUrl: project.web_url,
      cloneUrl: project.http_url_to_repo, username: account.username, baseBranch: config.baseBranch, targetBranch: config.targetBranch } }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}
