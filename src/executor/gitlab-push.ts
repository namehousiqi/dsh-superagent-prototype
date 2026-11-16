/** Controlled publication of a Ticket's feature branch. */
import { dirname } from 'node:path'
import type { TicketRepository } from '../app/ticket-repository.ts'
import { verifyGitlabWorkspace } from './gitlab-workspace.ts'

type GitlabTicket = Extract<TicketRepository, { provider: 'gitlab' }>
type Git = (args: string[], cwd: string) => Promise<string>
export interface PushState { lastSha?: string; pendingSha?: string; conflicted?: true }
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/** A lease requires an unchanged remote ref; ancestry is checked before using it, so the push cannot rewrite history. */
export async function pushGitlabBranch(snapshot: GitlabTicket, directory: string, git: Git,
  load: () => PushState | undefined, save: (state: PushState) => void, authorize: () => void): Promise<string> {
  if (snapshot.featureBranch === snapshot.baseBranch || snapshot.featureBranch === snapshot.targetBranch) throw new Error('Feature branch conflicts with a configured branch')
  const cwd = dirname(directory), run = (args: string[]) => git(['-C', directory, ...args], cwd)
  const config = (await run(['config', '-z', '--show-scope', '--list'])).split('\0')
  for (let i = 0; i + 1 < config.length; i += 2) {
    const scope = config[i], name = config[i + 1]!.split('\n', 1)[0]!.toLowerCase()
    if ((scope === 'local' || scope === 'worktree') && (/^credential\./.test(name) || /^http\..*\.extraheader$/.test(name)
      || /^http(?:\..*)?\.sslverify$/.test(name) || /^url\..*\.(insteadof|pushinsteadof)$/.test(name))) throw new Error('Ticket repository has unsafe local Git configuration')
  }
  await verifyGitlabWorkspace(snapshot, directory, git)
  const ref = `refs/heads/${snapshot.featureBranch}`
  await run(['check-ref-format', ref])
  const sha = (await run(['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
  if (!SHA.test(sha) || sha === snapshot.baseSha) throw new Error('Ticket has no committed changes to publish')
  const output = (await run(['ls-remote', '--heads', '--', snapshot.cloneUrl, ref])).trim()
  const lines = output ? output.split('\n') : []
  const remote = lines.length === 1 ? lines[0]!.split('\t') : []
  if (lines.length > 1 || (lines.length === 1 && (remote.length !== 2 || remote[1] !== ref || !SHA.test(remote[0]!)))) throw new Error('Unexpected GitLab remote branch response')
  const remoteSha = remote[0]
  const state = load() ?? {}
  if (state.conflicted) throw new Error('Ticket branch publication has a conflict requiring manual investigation')
  if ((state.lastSha && !SHA.test(state.lastSha)) || (state.pendingSha && !SHA.test(state.pendingSha))) throw new Error('Invalid saved GitLab branch publication state')
  if (remoteSha !== state.lastSha && !(state.pendingSha && remoteSha === state.pendingSha)) throw new Error('Ticket branch already exists or changed outside this Ticket')
  const confirmed = state.pendingSha && remoteSha === state.pendingSha ? remoteSha : state.lastSha
  if (confirmed && !remoteSha) throw new Error('Ticket branch was deleted outside this Ticket')
  if (remoteSha && remoteSha !== sha) await run(['merge-base', '--is-ancestor', remoteSha, sha])
  if (remoteSha === sha) { save({ lastSha: sha }); return sha }
  authorize()
  save({ ...confirmed ? { lastSha: confirmed } : {}, pendingSha: sha })
  try {
    authorize()
    await run(['-c', 'core.hooksPath=/dev/null', 'push', '--no-verify', `--force-with-lease=${ref}:${remoteSha ?? ''}`,
      '--', snapshot.cloneUrl, `${sha}:${ref}`])
  } catch (error) {
    // A failed command can also have succeeded remotely; keep pendingSha so a retry can reconcile it.
    throw error
  }
  save({ lastSha: sha })
  return sha
}
