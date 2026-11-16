/** Poll only merge requests already bound to Ticket threads. */
import { z } from 'zod'
import { key, type Thread, type Trigger } from '../core/index.ts'
import { gitlabProject } from '../deployment.ts'
import { KV } from '../kv.ts'
import type { Commands } from '../infra/commands.ts'
import type { SourceContext } from './host.ts'
import { gitlabThread, NoteSchema, noteTrigger, PipelineSchema, pipelineState } from './gitlab-events.ts'
import { mergeRequestUrl, readMergeRequest } from './gitlab-merge.ts'

const DiscussionSchema = z.object({ id: z.string().regex(/^[a-f0-9]{40,64}$/i), individual_note: z.boolean(), notes: z.array(NoteSchema) })
async function pages<T>(commands: Commands, item: z.ZodType<T>, path: string): Promise<T[]> {
  const result: T[] = []
  for (let page = 1; page <= 100; page++) {
    const batch = await commands.gitlabApi(z.array(item), path, { query: { per_page: '100', page: String(page) } })
    result.push(...batch)
    if (batch.length < 100) return result
  }
  throw new Error('GitLab response exceeds the safe pagination limit')
}

/** Recheck the binding after network reads: a removed subscription must not receive subsequent events. */
function bound(ctx: SourceContext, thread: Thread, ticketId: string): boolean {
  const ticket = ctx.tickets.get(ticketId)
  return !!ticket && thread.subscriptions.includes(ticketId) && !!ticket.follows?.some(f => f.own && f.thread === thread.key)
    && !!ctx.threads.get(thread.key)?.subscriptions.includes(ticketId)
}

export async function pollGitlabThread(ctx: SourceContext, thread: Thread, signal?: AbortSignal): Promise<void> {
  const project = gitlabProject(ctx.deployment)
  const { iid, ticketId } = thread.meta
  if (typeof iid !== 'number' || !Number.isSafeInteger(iid) || iid <= 0 || typeof ticketId !== 'string'
    || thread.ref.source !== 'gitlab' || thread.ref.id !== gitlabThread(project, iid) || thread.key !== `gitlab:${thread.ref.id}`) {
    throw new Error('Invalid GitLab merge request thread identity')
  }
  if (!bound(ctx, thread, ticketId)) return
  const snapshot = ctx.state.get(KV.ticketRepository(ticketId))
  if (!snapshot || snapshot.provider !== 'gitlab') throw new Error('Ticket has no fixed GitLab repository')
  const commands = ctx.commands.withSignal(signal)
  const mr = await readMergeRequest(commands, iid, snapshot, project)
  const root = `merge_requests/${iid}`
  const [noteResult, discussionResult, pipelineResult] = await Promise.allSettled([
    pages(commands, NoteSchema, `${root}/notes`), pages(commands, DiscussionSchema, `${root}/discussions`),
    pages(commands, PipelineSchema, `${root}/pipelines`),
  ])
  if (signal?.aborted) throw new Error('GitLab polling stopped')
  if (!bound(ctx, thread, ticketId)) return
  if (noteResult.status === 'fulfilled' && discussionResult.status === 'fulfilled') {
    const notes = noteResult.value, discussions = discussionResult.value, seen = new Set<string>()
    const discussionsByNote = new Map(discussions.filter(d => !d.individual_note).flatMap(d => d.notes.map(note => [note.id, d.id] as const)))
    // Discussions carry inline positions, so prefer their copy of a note over the generic notes endpoint.
    for (const note of [...discussions.flatMap(discussion => discussion.notes), ...notes].sort((a, b) => a.updated_at.localeCompare(b.updated_at))) {
      const trigger = noteTrigger(project, iid, note, discussionsByNote.get(note.id))
      if (!trigger.text || seen.has(trigger.id)) continue
      seen.add(trigger.id)
      if (signal?.aborted || !bound(ctx, thread, ticketId)) return
      await ctx.receive(trigger)
    }
  }
  if (signal?.aborted || !bound(ctx, thread, ticketId)) return
  const pipeline = pipelineResult.status === 'fulfilled' ? pipelineResult.value.filter(item => item.sha === mr.sha).sort((a, b) => b.id - a.id)[0] : undefined
  const status = pipelineState(mr.sha, pipeline)
  const fingerprint = JSON.stringify([mr.sha ?? null, pipeline?.id ?? null, status])
  const previous = ctx.state.get(KV.gitlab.ci(thread.ref.id))
  if (previous?.fingerprint !== fingerprint) {
    const revision = (previous?.revision ?? 0) + 1
    const trigger: Trigger = { id: key('gitlab-ci', thread.ref.id, String(revision)), source: 'gitlab', threads: [thread.ref],
      actor: { source: 'gitlab', id: '' }, human: false, at: new Date().toISOString(),
      text: `MR !${iid} CI: ${status} for ${mr.sha ?? 'unknown commit'}`, url: mergeRequestUrl(project, iid),
      meta: { iid, projectId: project.projectId, ci: true, sha: mr.sha ?? null, status } }
    await ctx.receive(trigger)
    ctx.state.set(KV.gitlab.ci(thread.ref.id), { fingerprint, revision })
  }
  ctx.threads.describe(thread.key, { facts: { ci: { label: 'CI', value: status, ...status === 'failed' ? { problem: true } : {} } } })
  if (mr.state === 'merged' || mr.state === 'closed') {
    const timestamp = mr.state === 'merged' ? mr.merged_at : mr.closed_at
    const at = timestamp && Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : new Date().toISOString()
    ctx.tickets.threadClosed(thread.ref, mr.state, at)
  }
  const failures = [noteResult.status === 'rejected' ? 'notes' : '', discussionResult.status === 'rejected' ? 'discussions' : '',
    pipelineResult.status === 'rejected' ? 'pipelines' : ''].filter(Boolean)
  if (failures.length) throw new Error(`GitLab MR polling incomplete: ${failures.join(', ')}`)
}
