import { describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { claimMergeRequest, mergeEndNotices } from '../src/sources/gitlab-pull.ts'
import { ticketRepository } from '../src/app/ticket-repository.ts'
import { testGitlabDeployment } from './fixtures/deployment.ts'

function setup() {
  const deployment = testGitlabDeployment(), snapshot = ticketRepository(deployment, 'fix-123')
  if (snapshot.provider !== 'gitlab') throw new Error('expected GitLab')
  const ticket = { id: 't1', follows: [], channels: [{ source: 'feishu', thread: 'chat', address: { chat: 'chat' } }] } as unknown as Ticket
  const mr = { iid: 9, project_id: 42, source_project_id: 42, target_project_id: 42, source_branch: snapshot.featureBranch,
    target_branch: snapshot.targetBranch, author: { username: deployment.gitlab.username }, state: 'opened' as const }
  const bindThread = vi.fn(), patch = vi.fn(), describe = vi.fn()
  const ctx = { deployment, state: { get: () => snapshot }, tickets: { get: () => ticket, open: () => [ticket], bindThread }, threads: { patch, describe } } as unknown as SourceContext
  return { ctx, ticket, mr, bindThread, patch, describe, project: deployment.gitlab }
}

describe('GitLab MR binding', () => {
  it('binds the verified MR as an owned thread with project-scoped identity', () => {
    const { ctx, ticket, mr, bindThread, patch, describe } = setup()
    claimMergeRequest(ctx, ticket.id, mr)
    expect(bindThread).toHaveBeenCalledWith('t1', { source: 'gitlab', id: 'git.example.test:42:9' }, true)
    expect(patch).toHaveBeenCalledWith('gitlab:git.example.test:42:9', expect.objectContaining({ iid: 9, ticketId: 't1' }))
    expect(describe).toHaveBeenCalledWith('gitlab:git.example.test:42:9', expect.objectContaining({ label: 'MR !9' }))
  })
  it('rejects an MR on a different target without binding', () => {
    const { ctx, ticket, mr, bindThread } = setup()
    expect(() => claimMergeRequest(ctx, ticket.id, { ...mr, target_branch: 'main' })).toThrow(/does not belong/)
    expect(bindThread).not.toHaveBeenCalled()
  })
  it('formats idempotent terminal messages only for the matching project', () => {
    const { ticket, project } = setup()
    const closed = { ...ticket, ended: { at: '2026-01-01T00:00:00Z', by: 'executor' as const, outcome: 'merged' as const },
      follows: [{ thread: 'gitlab:git.example.test:42:9', own: true, closed: { at: '2026-01-01T00:00:00Z', outcome: 'merged' as const } }] }
    const notices = mergeEndNotices(closed, '请修复', project)
    expect(notices).toHaveLength(1)
    expect(notices[0]!.text).toBe(`[MR !9](${project.webUrl}/-/merge_requests/9) 已合并。`)
    expect(mergeEndNotices(closed, '请修复', project)[0]!.id).toBe(notices[0]!.id)
    expect(mergeEndNotices(closed, '请修复', { ...project, projectId: 43 })).toEqual([])
  })
})
