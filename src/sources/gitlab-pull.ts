/** Bind a verified GitLab merge request to its Ticket and build terminal notices. */
import { key, liveTicket, type Follow, type OutboundMessage, type Ticket } from '../core/index.ts'
import { gitlabProject, type GitLabProject } from '../deployment.ts'
import { KV } from '../kv.ts'
import type { SourceContext } from './host.ts'
import { gitlabThread } from './gitlab-events.ts'
import { mergeRequestUrl, verifyMergeRequest, type GitlabMergeRequest } from './gitlab-merge.ts'

export function claimMergeRequest(ctx: SourceContext, ticketId: string, mr: GitlabMergeRequest): void {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) throw new Error('Ticket ended before merge request binding')
  const snapshot = ctx.state.get(KV.ticketRepository(ticketId))
  if (!snapshot || snapshot.provider !== 'gitlab') throw new Error('Ticket has no fixed GitLab repository')
  const project = gitlabProject(ctx.deployment)
  verifyMergeRequest(mr, snapshot, project)
  if (mr.state !== 'opened') throw new Error('Ticket can only bind an open GitLab merge request')
  const id = gitlabThread(project, mr.iid), thread = `gitlab:${id}`
  const other = ctx.tickets.open().find(item => item.id !== ticketId && item.follows?.some(f => f.thread === thread && !f.closed))
  if (other) throw new Error('GitLab merge request already belongs to another open Ticket')
  if (ticket.follows?.some(f => f.own && !f.closed && f.thread.startsWith('gitlab:') && f.thread !== thread)) {
    throw new Error('Ticket already follows a different open GitLab merge request')
  }
  ctx.tickets.bindThread(ticketId, { source: 'gitlab', id }, true)
  ctx.threads.patch(thread, { iid: mr.iid, projectId: project.projectId, host: project.host, ticketId })
  ctx.threads.describe(thread, { label: `MR !${mr.iid}`, url: mergeRequestUrl(project, mr.iid) })
}

/** Called in the ticket-ended transaction to enqueue an idempotent Feishu or other IM notice. */
export function mergeEndNotices(ticket: Ticket, request: string, project: GitLabProject): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  if (outcome !== 'merged' && outcome !== 'closed') return []
  const prefix = `gitlab:${project.host}:${project.projectId}:`
  const matching = (ticket.follows ?? []).filter(f => f.closed && f.thread.startsWith(prefix) && /^\d+$/.test(f.thread.slice(prefix.length)))
  const latest = (follows: Follow[]) => follows.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(matching.filter(f => f.own)) ?? latest(matching)
  if (!follow) return []
  const iid = Number(follow.thread.slice(prefix.length)), url = mergeRequestUrl(project, iid)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[MR !${iid}](${url}) 已合并。` : `[MR !${iid}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[MR !${iid}](${url}) has merged.` : `[MR !${iid}](${url}) was closed without merging.`
  return ticket.channels.filter(channel => channel.source !== 'gitlab').map(channel => ({
    id: key('mr-terminal', project.host, String(project.projectId), String(iid), channel.source, JSON.stringify(channel.address), outcome),
    channel, text, kind: 'notice', ticketId: ticket.id,
  }))
}
