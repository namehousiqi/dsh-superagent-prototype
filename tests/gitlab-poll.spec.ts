import { describe, expect, it, vi } from 'vitest'
import type { Thread, Ticket, Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { KV } from '../src/kv.ts'
import { ticketRepository } from '../src/app/ticket-repository.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { pollGitlabThread } from '../src/sources/gitlab-poll.ts'
import { testGitlabDeployment } from './fixtures/deployment.ts'

function fixture() {
  const deployment = testGitlabDeployment(), project = deployment.gitlab
  const snapshot = ticketRepository(deployment, 'fix-123')
  if (snapshot.provider !== 'gitlab') throw new Error('expected GitLab')
  const ref = { source: 'gitlab', id: `${project.host}:${project.projectId}:9` }
  const thread: Thread = { key: `gitlab:${ref.id}`, ref, createdAt: '2026-01-01T00:00:00Z', subscriptions: ['t1'],
    correlated: [], pending: [], meta: { iid: 9, ticketId: 't1' } }
  const ticket = { id: 't1', follows: [{ thread: thread.key, own: true }] } as Ticket
  const mr = { iid: 9, project_id: 42, source_project_id: 42, target_project_id: 42, source_branch: snapshot.featureBranch,
    target_branch: snapshot.targetBranch, author: { username: project.username }, state: 'opened', sha: 'new-sha' }
  const note = { id: 22, body: 'Please adjust', system: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', author: { username: 'reviewer' } }
  const state = new Map<string, unknown>([[KV.ticketRepository('t1'), snapshot]])
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const responses: Record<string, unknown> = { 'merge_requests/9': mr, 'merge_requests/9/notes': [note],
    'merge_requests/9/discussions': [{ id: 'a'.repeat(40), individual_note: false, notes: [note] }], 'merge_requests/9/pipelines': [{ id: 1, sha: 'old-sha', status: 'success' }] }
  const api = vi.spyOn(commands, 'gitlabApi').mockImplementation(async (schema, path) => schema.parse(responses[path]))
  const received: Trigger[] = []
  const threadClosed = vi.fn(), describe = vi.fn()
  const ctx = { deployment, commands, state: { get: (k: string) => state.get(k), set: (k: string, v: unknown) => state.set(k, v) },
    tickets: { get: () => ticket, threadClosed }, threads: { get: () => thread, describe },
    receive: (trigger: Trigger) => { received.push(trigger); return 'stored' } } as unknown as SourceContext
  return { ctx, thread, ticket, responses, received, threadClosed, describe, api, state }
}

describe('bound GitLab MR polling', () => {
  it('deduplicates discussion notes and never reports an old pipeline as passing', async () => {
    const f = fixture()
    await pollGitlabThread(f.ctx, f.thread)
    expect(f.received).toHaveLength(2)
    expect(f.received[0]!.text).toBe('Please adjust')
    expect(f.received[0]!.channel?.address).toMatchObject({ iid: '9', discussion: 'a'.repeat(40) })
    expect(f.received[1]!.meta).toMatchObject({ ci: true, sha: 'new-sha', status: 'unknown' })
    await pollGitlabThread(f.ctx, f.thread)
    expect(f.received.filter(t => t.meta.ci)).toHaveLength(1)
    expect(f.received.filter(t => t.meta.noteId === 22).map(t => t.id)[0]).toBe(f.received.filter(t => t.meta.noteId === 22)[1]!.id)
  })
  it('reports status transitions for the current head and closes a merged MR', async () => {
    const f = fixture()
    await pollGitlabThread(f.ctx, f.thread)
    f.responses['merge_requests/9/pipelines'] = [{ id: 2, sha: 'new-sha', status: 'success' }]
    f.responses['merge_requests/9'] = { ...(f.responses['merge_requests/9'] as object), state: 'merged', merged_at: '2026-01-02T00:00:00Z' }
    await pollGitlabThread(f.ctx, f.thread)
    expect(f.received.filter(t => t.meta.ci).at(-1)?.meta.status).toBe('passed')
    expect(f.threadClosed).toHaveBeenCalledWith(f.thread.ref, 'merged', '2026-01-02T00:00:00.000Z')
  })
  it('rejects a cross-project MR before reading its comments', async () => {
    const f = fixture()
    f.responses['merge_requests/9'] = { ...(f.responses['merge_requests/9'] as object), source_project_id: 123 }
    await expect(pollGitlabThread(f.ctx, f.thread)).rejects.toThrow(/does not belong/)
    expect(f.api).toHaveBeenCalledTimes(1)
    expect(f.received).toEqual([])
  })
  it('does not poll a removed binding', async () => {
    const f = fixture(); f.ticket.follows = []
    await pollGitlabThread(f.ctx, f.thread)
    expect(f.api).not.toHaveBeenCalled()
  })
  it('updates CI but waits for complete comment context when discussions fail', async () => {
    const f = fixture()
    f.responses['merge_requests/9/discussions'] = null
    await expect(pollGitlabThread(f.ctx, f.thread)).rejects.toThrow(/discussions/)
    expect(f.state.has(KV.gitlab.ci(f.thread.ref.id))).toBe(true)
    expect(f.received.some(trigger => trigger.meta.noteId)).toBe(false)
    expect(f.threadClosed).not.toHaveBeenCalled()
  })
  it('records a merged MR and unknown CI even when the pipelines endpoint fails', async () => {
    const f = fixture()
    f.responses['merge_requests/9/pipelines'] = [{ id: 2, sha: 'new-sha', status: 'success' }]
    await pollGitlabThread(f.ctx, f.thread)
    f.responses['merge_requests/9/pipelines'] = null
    f.responses['merge_requests/9'] = { ...(f.responses['merge_requests/9'] as object), state: 'merged', merged_at: '2026-01-02T00:00:00Z' }
    await expect(pollGitlabThread(f.ctx, f.thread)).rejects.toThrow(/pipelines/)
    expect(f.received.filter(t => t.meta.ci).at(-1)?.meta.status).toBe('unknown')
    expect(f.threadClosed).toHaveBeenCalledWith(f.thread.ref, 'merged', '2026-01-02T00:00:00.000Z')
  })
  it('prefers the inline discussion note with position over the duplicate generic note', async () => {
    const f = fixture()
    const plain = (f.responses['merge_requests/9/notes'] as object[])[0]!
    f.responses['merge_requests/9/discussions'] = [{ id: 'a'.repeat(40), individual_note: false,
      notes: [{ ...plain, position: { new_path: 'src/fix.ts', new_line: 42 } }] }]
    await pollGitlabThread(f.ctx, f.thread)
    expect(f.received.find(t => t.meta.noteId === 22)?.text).toBe('src/fix.ts:42\nPlease adjust')
  })
  it('ignores a different IID or a forged thread identifier', async () => {
    const f = fixture()
    f.thread.meta.iid = 10
    await expect(pollGitlabThread(f.ctx, f.thread)).rejects.toThrow(/identity/)
    expect(f.api).not.toHaveBeenCalled()
  })
})
