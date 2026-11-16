import { expect, it, vi } from 'vitest'
import type { Commands } from '../src/infra/commands.ts'
import { readGitlabRepositoryPath } from '../src/sources/gitlab-read.ts'
import { testGitlabDeployment } from './fixtures/deployment.ts'

const oid = 'a'.repeat(40)
function fixture(entries: { name: string; type: string; id: string }[]) {
  const gitlabApi = vi.fn(async (schema, path, options) => schema.parse(path === 'repository/tree'
    ? Number(options.query.page) === 1 ? entries : [] : { encoding: 'base64', content: Buffer.from('file contents').toString('base64') }))
  return { commands: { deployment: testGitlabDeployment(), gitlabApi } as unknown as Commands, gitlabApi }
}

it('reads only the configured base and hides private or dependency entries from directory listings', async () => {
  const f = fixture([{ name: 'z.ts', type: 'blob', id: oid }, { name: '.env', type: 'blob', id: oid },
    { name: 'node_modules', type: 'tree', id: oid }, { name: 'a.ts', type: 'blob', id: oid }])
  expect(await readGitlabRepositoryPath(f.commands, 'src', 'directory')).toBe('a.ts\nz.ts')
  expect(f.gitlabApi).toHaveBeenCalledWith(expect.anything(), 'repository/tree', { query: { ref: 'develop', path: 'src', per_page: '100', page: '1' } })
})

it('rejects hidden and parent paths without making an API request', async () => {
  const f = fixture([])
  for (const path of ['../secret', 'src/.env', 'src/node_modules/x']) {
    await expect(readGitlabRepositoryPath(f.commands, path, 'file')).rejects.toThrow(/non-hidden/)
  }
  expect(f.gitlabApi).not.toHaveBeenCalled()
})

it('finds a file on the next page and rejects a directory in its place', async () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({ name: `entry${i}`, type: 'blob', id: oid }))
  const f = fixture(entries)
  f.gitlabApi.mockImplementation(async (schema, path, options) => schema.parse(path !== 'repository/tree'
    ? { encoding: 'base64', content: Buffer.from('file contents').toString('base64') }
    : Number(options.query.page) === 1 ? entries : [{ name: 'found.ts', type: 'blob', id: oid }, { name: 'dir', type: 'tree', id: oid }]))
  expect(await readGitlabRepositoryPath(f.commands, 'found.ts', 'file')).toBe('file contents')
  await expect(readGitlabRepositoryPath(f.commands, 'dir', 'file')).rejects.toThrow(/not a file/)
})
