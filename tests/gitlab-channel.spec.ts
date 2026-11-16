import { describe, expect, it, vi } from 'vitest'
import type { OutboundMessage, Ticket } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { KV } from '../src/kv.ts'
import { ticketRepository } from '../src/app/ticket-repository.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { sendGitlab } from '../src/sources/gitlab-channel.ts'
import { testGitlabDeployment } from './fixtures/deployment.ts'

function fixture(discussion?: string) {
  const deployment = testGitlabDeployment(), snapshot = ticketRepository(deployment, 'fix-123')
  if (snapshot.provider !== 'gitlab') throw new Error('expected GitLab')
  const thread = `gitlab:${snapshot.host}:${snapshot.projectId}:9`
  const ticket = { id: 't1', follows: [{ thread, own: true }] } as Ticket
  const message: OutboundMessage = { id: 'reply-1', ticketId: 't1', kind: 'reply', text: 'Done',
    channel: { source: 'gitlab', thread, address: { iid: '9', ...discussion ? { discussion } : {} } } }
  const mr = { iid: 9, project_id: 42, source_project_id: 42, target_project_id: 42, source_branch: snapshot.featureBranch,
    target_branch: snapshot.targetBranch, author: { username: deployment.gitlab.username }, state: 'opened', sha: 'a'.repeat(40) }
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const api = vi.spyOn(commands, 'gitlabApi').mockImplementation(async (_schema, path, options) => {
    if (path === 'merge_requests/9') return mr
    if (options?.method === 'POST') return {}
    if (path.endsWith('/notes')) return []
    return { notes: [] }
  })
  const ctx = { deployment, commands, tickets: { get: () => ticket }, state: { get: (key: string) => key === KV.ticketRepository('t1') ? snapshot : undefined } } as unknown as SourceContext
  return { ctx, ticket, message, mr, api }
}

describe('GitLab bound MR replies', () => {
  it('writes a top-level reply and deduplicates retries by agent and message marker', async () => {
    const f = fixture()
    expect(await sendGitlab(f.ctx, f.message)).toBe('sent')
    expect(f.api).toHaveBeenCalledWith(expect.anything(), 'merge_requests/9/notes', { method: 'POST',
      fields: { body: 'Done\n\n<!-- dsh-superagent:reply-1 -->' } })
    f.api.mockImplementation(async (_schema, path) => path === 'merge_requests/9' ? f.mr : [{ body: '<!-- dsh-superagent:reply-1 -->', author: { username: f.ctx.deployment.gitlab!.username } }])
    expect(await sendGitlab(f.ctx, f.message)).toBe('sent')
    expect(f.api.mock.calls.filter(call => call[2]?.method === 'POST')).toHaveLength(1)
  })
  it('uses the original discussion and retrieves its notes to deduplicate', async () => {
    const id = 'b'.repeat(40), f = fixture(id)
    expect(await sendGitlab(f.ctx, f.message)).toBe('sent')
    expect(f.api).toHaveBeenCalledWith(expect.anything(), `merge_requests/9/discussions/${id}`)
    expect(f.api).toHaveBeenCalledWith(expect.anything(), `merge_requests/9/discussions/${id}/notes`, expect.objectContaining({ method: 'POST' }))
  })
  it('refuses other MR identities, detached Tickets and ended Tickets without posting', async () => {
    const f = fixture()
    f.message.channel.address.iid = '10'
    await expect(sendGitlab(f.ctx, f.message)).rejects.toThrow(/target/)
    f.message.channel.address.iid = '9'; f.ticket.follows = []
    await expect(sendGitlab(f.ctx, f.message)).rejects.toThrow(/authorized/)
    f.ticket.follows = [{ thread: f.message.channel.thread, own: true }]
    f.ticket.ended = { at: '2026-01-01T00:00:00Z', by: 'human', outcome: 'stopped' }
    await expect(sendGitlab(f.ctx, f.message)).rejects.toThrow(/authorized/)
    expect(f.api).not.toHaveBeenCalled()
  })
  it('rechecks binding after reading notes and stops before posting', async () => {
    const f = fixture()
    f.api.mockImplementation(async (_schema, path) => {
      if (path === 'merge_requests/9') return f.mr
      f.ticket.follows = []
      return []
    })
    await expect(sendGitlab(f.ctx, f.message)).rejects.toThrow(/authorized/)
    expect(f.api.mock.calls.some(call => call[2]?.method === 'POST')).toBe(false)
  })
  it('does not write to a closed MR or an MR from another project', async () => {
    const f = fixture()
    f.mr.state = 'closed'
    expect(await sendGitlab(f.ctx, f.message)).toBe('gone')
    f.mr.state = 'opened'; f.mr.source_project_id = 5
    await expect(sendGitlab(f.ctx, f.message)).rejects.toThrow(/does not belong/)
    expect(f.api.mock.calls.some(call => call[2]?.method === 'POST')).toBe(false)
  })
})
