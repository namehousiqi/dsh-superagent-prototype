import { describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { KV } from '../src/kv.ts'
import { ticketRepository } from '../src/app/ticket-repository.ts'
import { GitlabPublisher } from '../src/executor/gitlab-publish.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { testGitlabDeployment } from './fixtures/deployment.ts'

function fixture() {
  const deployment = testGitlabDeployment(), initial = ticketRepository(deployment, 'fix-123')
  if (initial.provider !== 'gitlab') throw new Error('expected GitLab')
  const snapshot = { ...initial, baseSha: '1'.repeat(40) }, sha = '2'.repeat(40)
  const ticket = { id: 't1', title: 'Fix', execution: { directory: '/tmp/work', name: 'fix-123', assignment: '' },
    origin: { triggerId: 'feishu-1', triggerIds: ['feishu-1'] }, follows: [] } as unknown as Ticket
  const mr = { iid: 9, project_id: 42, source_project_id: 42, target_project_id: 42, source_branch: snapshot.featureBranch,
    target_branch: snapshot.targetBranch, author: { username: deployment.gitlab.username }, state: 'opened', sha }
  const state = new Map<string, unknown>([[KV.ticketRepository('t1'), snapshot]])
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  vi.spyOn(commands, 'withSignal').mockReturnValue(commands)
  const git = vi.spyOn(commands, 'git').mockImplementation(async args => {
    if (args.includes('config')) return ''
    if (args.includes('get-url')) return snapshot.cloneUrl
    if (args.includes('--show-current')) return snapshot.featureBranch
    if (args.includes('rev-parse')) return sha
    return ''
  })
  const targetSha = '4'.repeat(40), extraSha = '5'.repeat(40)
  const api = vi.spyOn(commands, 'gitlabApi').mockImplementation(async (_schema, path, options) => {
    if (path === 'repository/commits') return [{ id: targetSha }]
    if (path === 'repository/compare') return { compare_timeout: false,
      commits: options?.query?.to === snapshot.baseSha ? [{ id: extraSha, title: 'Base change' }] : [{ id: sha, title: 'Ticket change' }],
      diffs: [{ old_path: 'one.ts', new_path: 'one.ts', diff: '@@ -1 +1 @@' }] }
    return options?.method === 'POST' ? mr : []
  })
  const bindThread = vi.fn(), patch = vi.fn(), describe = vi.fn()
  const ctx = { deployment, commands, state: { get: (k: string) => state.get(k), set: (k: string, v: unknown) => state.set(k, v) },
    tickets: { get: () => ticket, open: () => [ticket], bindThread }, triggers: { get: () => ({ source: 'feishu' }) },
    threads: { patch, describe }, atomic: (work: () => unknown) => work() } as unknown as SourceContext
  return { publisher: new GitlabPublisher(() => ctx), ctx, ticket, snapshot, sha, state, git, api, bindThread }
}

describe('GitLab host publisher', () => {
  it('pushes the Ticket branch, creates and binds the verified MR, and warns about the different target', async () => {
    const f = fixture()
    const result = await f.publisher.publish('t1', 'Fix', 'Summary')
    expect(result).toMatchObject({ iid: 9, source_branch: f.snapshot.featureBranch, base_branch: 'develop', target_branch: 'release', head_sha: f.sha })
    expect(result.warning).toMatch(/complete diff/)
    expect(result.comparison).toMatchObject({ target_sha: '4'.repeat(40), head: { incomplete: false, commits: [{ id: f.sha }] },
      development_base: { incomplete: false, commits: [{ id: '5'.repeat(40) }] }, conflict_status: 'unknown' })
    expect(f.api).toHaveBeenCalledWith(expect.anything(), 'repository/compare', { query: { from: '4'.repeat(40), to: f.sha, straight: 'false' } })
    expect(f.state.get(KV.gitlab.push('t1'))).toEqual({ lastSha: f.sha })
    expect(f.bindThread).toHaveBeenCalledWith('t1', { source: 'gitlab', id: 'git.example.test:42:9' }, true)
    expect(f.api).toHaveBeenCalledTimes(5)
  })
  it('keeps the MR binding and reports unknown when comparison cannot be read', async () => {
    const f = fixture()
    const original = f.api.getMockImplementation()!
    f.api.mockImplementation(async (schema, path, options) => {
      if (path === 'repository/commits') throw new Error('unavailable')
      return original(schema, path, options)
    })
    const result = await f.publisher.publish('t1', 'Fix', '')
    expect(result.comparison).toBeNull()
    expect(result.warning).toMatch(/unknown/)
    expect(f.bindThread).toHaveBeenCalledOnce()
  })
  it('marks truncated comparisons incomplete', async () => {
    const f = fixture()
    const original = f.api.getMockImplementation()!
    f.api.mockImplementation(async (schema, path, options) => {
      if (path === 'repository/compare') return { compare_timeout: true, commits: [], diffs: [] }
      return original(schema, path, options)
    })
    const result = await f.publisher.publish('t1', 'Fix', '')
    expect(result.comparison?.head.incomplete).toBe(true)
    expect(result.warning).toMatch(/incomplete/)
  })
  it('stops before MR creation when the Ticket ends during remote lookup', async () => {
    const f = fixture()
    f.api.mockImplementationOnce(async () => { f.ticket.ended = { at: '2026-01-01', by: 'human', outcome: 'stopped' }; return [] })
    await expect(f.publisher.publish('t1', 'Fix', '')).rejects.toThrow(/authorization changed/)
    expect(f.api).toHaveBeenCalledTimes(1)
    expect(f.bindThread).not.toHaveBeenCalled()
  })
  it('does not bind an MR whose head is not yet the published commit', async () => {
    const f = fixture()
    f.api.mockResolvedValueOnce([]).mockResolvedValueOnce({ iid: 9, project_id: 42, source_project_id: 42, target_project_id: 42,
      source_branch: f.snapshot.featureBranch, target_branch: f.snapshot.targetBranch, author: { username: f.ctx.deployment.gitlab!.username }, state: 'opened', sha: '3'.repeat(40) })
    await expect(f.publisher.publish('t1', 'Fix', '')).rejects.toThrow(/not confirmed/)
    expect(f.bindThread).not.toHaveBeenCalled()
  })
  it('rejects concurrent publication for the same Ticket', async () => {
    const f = fixture()
    let release!: () => void, started!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const waiting = new Promise<void>(resolve => { started = resolve })
    f.git.mockImplementation(async args => {
      if (args.includes('ls-remote')) { started(); await gate; return '' }
      if (args.includes('config')) return ''
      if (args.includes('get-url')) return f.snapshot.cloneUrl
      if (args.includes('--show-current')) return f.snapshot.featureBranch
      if (args.includes('rev-parse')) return f.sha
      return ''
    })
    const first = f.publisher.publish('t1', 'Fix', '')
    await waiting
    await expect(f.publisher.publish('t1', 'Fix', '')).rejects.toThrow(/already running/)
    release()
    await expect(first).resolves.toMatchObject({ iid: 9 })
  })
  it('refuses publication when the origin is not a Feishu message', async () => {
    const f = fixture()
    f.ctx.triggers.get = () => ({ source: 'github' }) as never
    await expect(f.publisher.publish('t1', 'Fix', '')).rejects.toThrow(/authorization changed/)
    expect(f.git).not.toHaveBeenCalled()
    expect(f.api).not.toHaveBeenCalled()
  })
})
