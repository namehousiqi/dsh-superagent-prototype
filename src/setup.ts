/** Structured startup and configuration errors with the settings location where the operator can fix them. */
import { fill } from './infra/text.ts'

export type SetupPlace = 'deployment' | 'github' | 'gitlab' | 'feishu'
export const SETUP_PROBLEMS = {
  foreignFile: ['deployment', '{file} was not written by dsh-superagent; move it, or choose another state directory.'],
  gitTooOld: ['deployment', 'git does not read the configured repository credential helper; dsh-superagent needs git 2.32 or later.'],
  environmentFailed: ['deployment', 'Preparing the agent environment failed.'],
  repositoryUnset: ['github', 'The GitHub Source names no repository.'],
  agentCliUnset: ['github', 'The agent GitHub CLI is not set.'],
  agentCliMissing: ['github', 'The agent GitHub CLI was not found.'],
  agentCliSignedOut: ['github', 'The agent GitHub CLI cannot read its account.'],
  agentCliNoAccount: ['github', 'The agent GitHub CLI did not report a GitHub account.'],
  repositoryUnreadable: ['github', '@{account} cannot read {repository}.'],
  repositoryUnreported: ['github', 'The agent GitHub CLI did not return {repository}.'],
  repositoryReadOnly: ['github', '@{account} cannot push to {repository}.'],
  gitlabRepositoryUnset: ['gitlab', 'The GitLab Source has no repository URL.'],
  gitlabRepositoryInvalid: ['gitlab', 'Use an HTTPS GitLab repository URL without credentials, query or fragment.'],
  gitlabBranchesUnset: ['gitlab', 'Set both the development base branch and the merge request target branch.'],
  gitlabCliUnset: ['gitlab', 'The agent glab CLI is not set.'],
  gitlabCliMissing: ['gitlab', 'The agent glab CLI was not found.'],
  gitlabCliFailed: ['gitlab', 'The agent glab CLI failed; check its account, permissions, network and TLS configuration.'],
  gitlabCliSignedOut: ['gitlab', 'The agent glab CLI cannot read its GitLab account.'],
  gitlabRepositoryUnreadable: ['gitlab', 'The agent cannot read project {repository}.'],
  gitlabRepositoryMismatch: ['gitlab', 'The GitLab project returned a repository URL that does not match the configured instance and project.'],
  gitlabMergeRequestForbidden: ['gitlab', 'This GitLab account cannot create merge requests in the project.'],
  gitlabBaseBranchMissing: ['gitlab', 'Development base branch {branch} does not exist.'],
  gitlabTargetBranchMissing: ['gitlab', 'Merge request target branch {branch} does not exist.'],
  feishuCliFailed: ['feishu', 'The bot lark-cli does not work.'],
  feishuNoApp: ['feishu', 'auth status of the bot lark-cli did not report the app.'],
  feishuBotNotReady: ['feishu', 'The bot identity of app {app} is {status}; configure the app secret with lark-cli.'],
  feishuUserIdentity: ['feishu', 'The bot lark-cli allows user identities (strict mode {mode}); give the bot its own lark-cli configuration in strict mode bot, as docs/006-deployment.md describes.'],
  feishuNoBot: ['feishu', 'The Feishu bot API did not return the bot\'s open_id.'],
} as const satisfies Record<string, readonly [SetupPlace, string]>
export type SetupCode = keyof typeof SETUP_PROBLEMS
export interface SetupProblem { place: SetupPlace; code: SetupCode; values: Record<string, string>; detail: string }

/**
 * Thrown by deployment and account verification checks when a required CLI, account, or repository check fails.
 * `Setup` records it for the management overview, and the HTTP layer returns `problem` so the panel can localize it.
 */
export class SetupError extends Error {
  readonly place: SetupPlace
  constructor(readonly code: SetupCode, readonly values: Record<string, string> = {}) {
    const [place, text] = SETUP_PROBLEMS[code]
    const sentence = fill(text, values)
    super(values.output ? `${sentence}\n${values.output}` : sentence)
    this.place = place
  }
  get problem(): SetupProblem { return { place: this.place, code: this.code, values: this.values, detail: this.message } }
}
