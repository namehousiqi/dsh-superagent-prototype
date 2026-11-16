/** Deliver replies only to a Ticket's verified GitLab MR, with retry deduplication. */
import { z } from 'zod'
import { liveTicket, type OutboundMessage } from '../core/index.ts'
import { gitlabProject } from '../deployment.ts'
import { KV } from '../kv.ts'
import { sameRepository } from '../app/ticket-repository.ts'
import type { SourceContext } from './host.ts'
import { gitlabThread } from './gitlab-events.ts'
import { readMergeRequest } from './gitlab-merge.ts'

const ReplyNote = z.object({ body: z.string().nullable(), author: z.object({ username: z.string() }) })

export async function sendGitlab(ctx: SourceContext, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const project = gitlabProject(ctx.deployment), address = message.channel.address
  if (!/^[1-9]\d*$/.test(address.iid ?? '')) throw new Error('Invalid GitLab reply target')
  const iid = Number(address.iid)
  if (!Number.isSafeInteger(iid) || (address.discussion && !/^[a-f0-9]{40,64}$/i.test(address.discussion))
    || message.channel.thread !== `gitlab:${gitlabThread(project, iid)}` || !message.ticketId) throw new Error('Invalid GitLab reply target')
  const ticketId = message.ticketId
  const authorize = () => {
    const ticket = ctx.tickets.get(ticketId), snapshot = ctx.state.get(KV.ticketRepository(ticketId))
    if (!ticket || !liveTicket(ticket) || !ticket.follows?.some(f => f.own && !f.closed && f.thread === message.channel.thread)
      || !snapshot || snapshot.provider !== 'gitlab' || !sameRepository(snapshot, ctx.deployment)) {
      throw new Error('GitLab reply is no longer authorized for this Ticket')
    }
    return snapshot
  }
  const snapshot = authorize()
  const mr = await readMergeRequest(ctx.commands, iid, snapshot, project)
  if (mr.state !== 'opened') return 'gone'
  const root = `merge_requests/${iid}`
  const path = address.discussion ? `${root}/discussions/${address.discussion}/notes` : `${root}/notes`
  const marker = `<!-- dsh-superagent:${message.id} -->`
  const contains = (notes: z.infer<typeof ReplyNote>[]) => notes.some(note => note.author.username.toLowerCase() === project.username.toLowerCase()
    && (note.body ?? '').includes(marker))
  if (address.discussion) {
    const discussion = await ctx.commands.gitlabApi(z.object({ notes: z.array(ReplyNote) }), `${root}/discussions/${address.discussion}`)
    if (contains(discussion.notes)) return 'sent'
    authorize()
    await ctx.commands.gitlabApi(z.unknown(), path, { method: 'POST', fields: { body: `${message.text}\n\n${marker}` } })
    return 'sent'
  }
  for (let page = 1; page <= 100; page++) {
    const notes = await ctx.commands.gitlabApi(z.array(ReplyNote), path, { query: { per_page: '100', page: String(page) } })
    if (contains(notes)) return 'sent'
    if (notes.length < 100) {
      authorize()
      await ctx.commands.gitlabApi(z.unknown(), path, { method: 'POST', fields: { body: `${message.text}\n\n${marker}` } })
      return 'sent'
    }
  }
  throw new Error('GitLab reply history exceeds the safe pagination limit')
}
