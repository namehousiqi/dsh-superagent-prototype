import { mkdirSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { Setup } from '../src/app/setup.ts'
import { KV } from '../src/kv.ts'
import { Commands } from '../src/infra/commands.ts'
import { gitlabKind } from '../src/sources/gitlab.ts'
import { pollGitlabThread } from '../src/sources/gitlab-poll.ts'
import { noteTrigger } from '../src/sources/gitlab-events.ts'
import { mergeEndNotices } from '../src/sources/gitlab-pull.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { testGitlabDeployment } from './fixtures/deployment.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined; vi.restoreAllMocks() })

it('runs a Feishu Ticket through GitLab workspace, publication and bound MR events', async () => {
  const deployment = testGitlabDeployment(), project = deployment.gitlab
  const base = '1'.repeat(40), head = '2'.repeat(40), target = '3'.repeat(40)
  vi.spyOn(Setup.prototype, 'run').mockResolvedValue(true)
  vi.spyOn(Setup.prototype, 'configured').mockReturnValue(true)
  vi.spyOn(Setup.prototype, 'deployment', 'get').mockReturnValue(deployment)
  host = await startRuntime(store => {
    const settings = store.settings()
    store.saveSettings({ ...settings, executor: { ...settings.executor, repositorySource: 'gitlab' } })
  })
  const h = host
  h.runtime.sources.register(gitlabKind)
  let branch = ''
  h.subprocess.spawn.mockImplementation((spec: { argv: readonly string[] }) => {
    const args = [...spec.argv]
    if (args[1] === 'clone') mkdirSync(args.at(-1)!, { recursive: true })
    if (args.includes('checkout')) branch = args[args.indexOf('-b') + 1]!
    let output = ''
    if (args.includes('rev-parse')) output = base
    if (args.includes('get-url')) output = project.cloneUrl
    if (args.includes('--show-current')) output = branch
    const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
    return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: reader(output), stderr: reader('') } }
  })
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', 'Fix the defect'))
  const saved = h.runtime.store.get(KV.ticketRepository(ticket.id))
  expect(saved).toMatchObject({ provider: 'gitlab', baseBranch: 'develop', targetBranch: 'release', baseSha: base })
  expect(branch).toBe(`agent/${ticket.execution!.name}`)
  expect(h.tools.get(sessionId)?.has('orchestrator_gitlab_publish')).toBe(true)
  vi.mocked(Commands.prototype.git).mockImplementation(async args => {
    if (args.includes('get-url')) return project.cloneUrl
    if (args.includes('--show-current')) return branch
    if (args.includes('rev-parse')) return head
    return ''
  })
  const mr = { iid: 9, project_id: project.projectId, source_project_id: project.projectId, target_project_id: project.projectId,
    source_branch: branch, target_branch: project.targetBranch, author: { username: project.username }, state: 'opened', sha: head,
    merged_at: null as string | null }
  const note = { id: 10, body: 'Please fix the test', system: false, created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z', author: { username: 'reviewer' } }
  vi.spyOn(Commands.prototype, 'gitlabApi').mockImplementation(async (schema, path, options) => {
    let response: unknown
    if (path === 'merge_requests') response = options?.method === 'POST' ? mr : []
    else if (path === 'merge_requests/9') response = mr
    else if (path === 'merge_requests/9/notes') response = [note]
    else if (path === 'merge_requests/9/discussions') response = []
    else if (path === 'merge_requests/9/pipelines') response = [{ id: 1, sha: head, status: 'success' }]
    else if (path === 'repository/commits') response = [{ id: target }]
    else if (path === 'repository/compare') response = { compare_timeout: false, commits: [], diffs: [] }
    else throw new Error(`Unexpected GitLab path: ${path}`)
    return schema.parse(response)
  })
  const published = await h.runTool(sessionId, 'orchestrator_gitlab_publish', { title: 'Fix defect', description: 'Fix and test' })
  expect(published).toMatchObject({ iid: 9, head_sha: head, target_branch: 'release' })
  const ref = `gitlab:${project.host}:${project.projectId}:9`
  const thread = h.runtime.store.threads.get(ref)!
  expect(thread.subscriptions).toContain(ticket.id)
  await pollGitlabThread(h.runtime.context(gitlabKind), thread)
  expect(h.runtime.store.triggers.get(noteTrigger(project, 9, note).id)?.text).toBe(note.body)
  expect(h.runtime.store.tickets.get(ticket.id)!.inputs.some(input => input.kind === 'trigger' && input.human)).toBe(true)
  expect(h.runtime.store.get(KV.gitlab.ci(`${project.host}:${project.projectId}:9`))?.fingerprint).toContain('passed')
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'MR ready and verified' })
  mr.state = 'merged'; mr.merged_at = new Date().toISOString()
  await pollGitlabThread(h.runtime.context(gitlabKind), h.runtime.store.threads.get(ref)!)
  expect(h.runtime.store.tickets.get(ticket.id)?.follows?.find(f => f.thread === ref)?.closed?.outcome).toBe('merged')
  expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('merged')
  const notice = mergeEndNotices(h.runtime.store.tickets.get(ticket.id)!, 'Fix the defect', project)[0]!
  expect(notice.channel.source).toBe('feishu')
  expect(h.runtime.store.receipts.get(notice.id)?.text).toContain('has merged')
})
