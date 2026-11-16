import { describe, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { ticketRepository } from '../src/app/ticket-repository.ts'
import { ensureMergeRequest, mergeRequestUrl, readMergeRequest } from '../src/sources/gitlab-merge.ts'
import { testGitlabDeployment } from './fixtures/deployment.ts'

function fixture() {
  const deployment = testGitlabDeployment(), ticket = ticketRepository(deployment, 'fix-123')
  if (ticket.provider !== 'gitlab') throw new Error('expected GitLab')
  const project = deployment.gitlab
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const call = vi.spyOn(commands, 'gitlabApi')
  const mr = { iid: 9, project_id: 42, source_project_id: 42, target_project_id: 42,
    source_branch: ticket.featureBranch, target_branch: ticket.targetBranch, author: { username: project.username }, state: 'opened', sha: 'abc' }
  return { ticket, project, commands, call, mr }
}

describe('GitLab Ticket merge requests', () => {
  it('creates only on the fixed source and target after finding no matching MR', async () => {
    const { ticket, project, commands, call, mr } = fixture()
    call.mockResolvedValueOnce([]).mockResolvedValueOnce(mr)
    await expect(ensureMergeRequest(commands, ticket, project, 'Fix', 'Details')).resolves.toEqual(mr)
    expect(call).toHaveBeenNthCalledWith(2, expect.anything(), 'merge_requests', { method: 'POST', fields: {
      source_branch: ticket.featureBranch, target_branch: ticket.targetBranch, title: 'Fix', description: 'Details',
    } })
    expect(mergeRequestUrl(project, 9)).toBe(`${project.webUrl}/-/merge_requests/9`)
  })
  it('reuses an existing MR on retry without a second write', async () => {
    const { ticket, project, commands, call, mr } = fixture()
    call.mockResolvedValueOnce([mr])
    await expect(ensureMergeRequest(commands, ticket, project, 'Fix', '')).resolves.toEqual(mr)
    expect(call).toHaveBeenCalledTimes(1)
  })
  it.each([
    { target_project_id: 43 }, { source_project_id: 43 }, { project_id: 43 }, { target_branch: 'main' }, { author: { username: 'other' } },
  ])('rejects a competing MR instead of writing: %j', async changed => {
    const { ticket, project, commands, call, mr } = fixture()
    call.mockResolvedValueOnce([{ ...mr, ...changed }])
    await expect(ensureMergeRequest(commands, ticket, project, 'Fix', '')).rejects.toThrow(/does not belong/)
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('rejects a changed deployment before any API call', async () => {
    const { ticket, project, commands, call } = fixture()
    await expect(ensureMergeRequest(commands, { ...ticket, projectId: 999 }, project, 'Fix', '')).rejects.toThrow(/does not match/)
    expect(call).not.toHaveBeenCalled()
  })
  it('validates an explicitly read IID and refuses a different response', async () => {
    const { ticket, project, commands, call, mr } = fixture()
    call.mockResolvedValueOnce({ ...mr, iid: 10 })
    await expect(readMergeRequest(commands, 9, ticket, project)).rejects.toThrow(/different/)
    await expect(readMergeRequest(commands, 0, ticket, project)).rejects.toThrow(/Invalid/)
  })
})
