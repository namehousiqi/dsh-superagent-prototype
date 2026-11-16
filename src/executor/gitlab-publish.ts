/** Host-controlled GitLab publication for a single live Feishu Ticket. */
import { z } from 'zod'
import { liveTicket } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { gitlabProject } from '../deployment.ts'
import { KV } from '../kv.ts'
import { sameRepository } from '../app/ticket-repository.ts'
import type { SourceContext } from '../sources/host.ts'
import { claimMergeRequest } from '../sources/gitlab-pull.ts'
import { ensureMergeRequest, mergeRequestUrl } from '../sources/gitlab-merge.ts'
import { pushGitlabBranch } from './gitlab-push.ts'

const Sha = z.string().regex(/^[a-f0-9]{40,64}$/i)
const Compare = z.object({ compare_timeout: z.boolean().optional(), commits: z.array(z.object({ id: Sha, title: z.string() })),
  diffs: z.array(z.object({ old_path: z.string(), new_path: z.string(), diff: z.string().optional(),
    new_file: z.boolean().optional(), deleted_file: z.boolean().optional(), renamed_file: z.boolean().optional(),
    collapsed: z.boolean().optional(), too_large: z.boolean().optional() })) })
async function compareTarget(commands: Commands, target: string, head: string, base: string) {
  const latest = await commands.gitlabApi(z.array(z.object({ id: Sha })).min(1), 'repository/commits',
    { query: { ref_name: target, per_page: '1' } })
  const targetSha = latest[0]!.id
  const compare = (to: string) => commands.gitlabApi(Compare, 'repository/compare', { query: { from: targetSha, to, straight: 'false' } })
  const [mr, baseOnly] = await Promise.all([compare(head), compare(base)])
  const summary = (result: z.infer<typeof Compare>) => ({
    commits: result.commits.slice(0, 100).map(({ id, title }) => ({ id, title: title.slice(0, 300) })),
    files: result.diffs.slice(0, 100).map(({ old_path, new_path, new_file, deleted_file, renamed_file, collapsed, too_large, diff }) =>
      ({ old_path, new_path, new_file, deleted_file, renamed_file, content_unavailable: !!collapsed || !!too_large || !diff })),
    incomplete: result.compare_timeout !== false || result.commits.length > 100 || result.diffs.length > 100
      || result.diffs.some(diff => !!diff.collapsed || !!diff.too_large || !diff.diff),
  })
  return { target_sha: targetSha, head: summary(mr), development_base: summary(baseOnly),
    conflict_status: 'unknown' as const }
}

/** Serializes each Ticket's authorized branch publication and verifies its GitLab MR binding. */
export class GitlabPublisher {
  private readonly running = new Set<string>()
  constructor(private readonly source: () => SourceContext) {}

  async publish(ticketId: string, title: string, description: string, signal?: AbortSignal) {
    if (this.running.has(ticketId)) throw new Error('GitLab publication is already running for this Ticket')
    this.running.add(ticketId)
    try {
      const ctx = this.source(), ticket = ctx.tickets.get(ticketId)
      const snapshot = ctx.state.get(KV.ticketRepository(ticketId))
      if (!ticket?.execution?.directory || !snapshot || snapshot.provider !== 'gitlab') throw new Error('Ticket has no fixed GitLab workspace')
      const project = gitlabProject(ctx.deployment), directory = ticket.execution.directory
      const authorize = () => {
        const current = ctx.tickets.get(ticketId)
        if (signal?.aborted || !current || !liveTicket(current) || current.execution?.directory !== directory
          || ctx.triggers.get(current.origin.triggerId)?.source !== 'feishu' || !sameRepository(snapshot, ctx.deployment)) {
          throw new Error('GitLab publication authorization changed')
        }
      }
      authorize()
      const commands = ctx.commands.withSignal(signal)
      const git = async (args: string[], cwd: string): Promise<string> => {
        try { return await commands.git(args, cwd) }
        catch (error) { if (signal?.aborted) throw error; throw new Error('GitLab branch operation failed; inspect the workspace and remote branch') }
      }
      const sha = await pushGitlabBranch(snapshot, directory, git, () => ctx.state.get(KV.gitlab.push(ticketId)),
        state => ctx.state.set(KV.gitlab.push(ticketId), state), authorize)
      authorize()
      const mr = await ensureMergeRequest(commands, snapshot, project, title, description, authorize)
      if (mr.sha !== sha) throw new Error('GitLab has not confirmed the published commit as the MR head; retry after it updates')
      ctx.atomic(() => { authorize(); claimMergeRequest(ctx, ticketId, mr) })
      const comparison = await compareTarget(commands, snapshot.targetBranch, sha, snapshot.baseSha!)
        .catch(() => null)
      return { iid: mr.iid, url: mergeRequestUrl(project, mr.iid), source_branch: snapshot.featureBranch,
        base_branch: snapshot.baseBranch, base_sha: snapshot.baseSha, target_branch: snapshot.targetBranch, head_sha: sha,
        comparison,
        ...(!comparison ? { warning: 'Target comparison unavailable; the MR diff and additional base changes are unknown. Inspect the complete MR diff before reporting readiness.' }
          : comparison.head.incomplete || comparison.development_base.incomplete
            ? { warning: 'Target comparison is incomplete; inspect the complete MR diff and additional base changes before reporting readiness.' }
            : snapshot.baseBranch !== snapshot.targetBranch ? { warning: 'The MR targets a different branch from its development base; inspect the complete diff and disclose any additional base changes.' } : {}) }
    } finally { this.running.delete(ticketId) }
  }
}
