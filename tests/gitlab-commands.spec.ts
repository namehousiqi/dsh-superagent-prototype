import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment, testGitlabDeployment } from './fixtures/deployment.ts'

describe('scoped GitLab API', () => {
  it('uses the configured host and project ID, with encoded query and literal fields', async () => {
    const commands = new Commands(() => testGitlabDeployment(), {}, new AbortController().signal)
    const run = vi.spyOn(commands, 'run').mockResolvedValue('{"iid":7}')
    await expect(commands.gitlabApi(z.object({ iid: z.number() }), 'merge_requests', { method: 'POST', fields: { title: 'test $(unsafe)', source_branch: 'agent/fix' } })).resolves.toEqual({ iid: 7 })
    expect(run).toHaveBeenCalledWith('/bin/false', ['api', '/projects/42/merge_requests', '--hostname', 'git.example.test', '--method', 'POST', '--raw-field', 'title=test $(unsafe)', '--raw-field', 'source_branch=agent/fix'])
    run.mockResolvedValue('[]')
    await commands.gitlabApi(z.array(z.unknown()), 'merge_requests', { query: { state: 'opened', source_branch: 'agent/a&b' } })
    expect(run).toHaveBeenLastCalledWith('/bin/false', ['api', '/projects/42/merge_requests?state=opened&source_branch=agent%2Fa%26b', '--hostname', 'git.example.test'])
  })
  it('rejects paths outside the project and refuses a GitHub deployment', async () => {
    const commands = new Commands(() => testGitlabDeployment(), {}, new AbortController().signal)
    for (const path of ['/user', '../other', 'merge_requests/../user', 'merge_requests%2f..', 'merge_requests?other=1', 'https://evil.test']) {
      await expect(commands.gitlabApi(z.unknown(), path)).rejects.toThrow(/restricted/i)
    }
    await expect(new Commands(() => testDeployment(), {}, new AbortController().signal).gitlabApi(z.unknown(), 'merge_requests')).rejects.toThrow(/GitLab/)
  })
  it('does not expose CLI stderr in errors', async () => {
    const commands = new Commands(() => testGitlabDeployment(), {}, new AbortController().signal)
    vi.spyOn(commands, 'run').mockRejectedValue(new Error('unexpected secret value'))
    await expect(commands.gitlabApi(z.unknown(), 'merge_requests')).rejects.not.toThrow('secret value')
  })
})
