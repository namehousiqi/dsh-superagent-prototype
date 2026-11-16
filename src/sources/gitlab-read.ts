/** Read the configured GitLab development branch for admission assessment. */
import { z } from 'zod'
import { gitlabProject } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'

const TreeEntry = z.object({ name: z.string(), type: z.string(), id: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i) })
const Blob = z.object({ encoding: z.literal('base64'), content: z.string() })

/** Apply the same non-hidden source-path restriction as GitHub and read only the configured base branch. */
export async function readGitlabRepositoryPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  if (kind === 'file' && !parts.length) throw new Error('A repository file path is required')
  const name = kind === 'file' ? parts.pop() : undefined
  const ref = gitlabProject(commands.deployment).baseBranch
  const entries: z.infer<typeof TreeEntry>[] = []
  for (let page = 1; page <= 100; page++) {
    const batch = await commands.gitlabApi(z.array(TreeEntry), 'repository/tree', {
      query: { ref, path: parts.join('/'), per_page: '100', page: String(page) },
    })
    if (name) {
      const entry = batch.find(item => item.name === name)
      if (entry) {
        if (entry.type !== 'blob') throw new Error(`${path} is not a file`)
        const blob = await commands.gitlabApi(Blob, `repository/blobs/${entry.id}`)
        const content = blob.content.replace(/\s/g, '')
        if (content.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw new Error('Invalid GitLab blob encoding')
        return Buffer.from(content, 'base64').toString('utf8')
      }
    } else entries.push(...batch)
    if (batch.length < 100) {
      if (name) throw new Error(`${path} was not found in the configured base branch`)
      return entries.map(entry => entry.name).filter(item => !item.startsWith('.') && item !== 'node_modules').sort().join('\n')
    }
  }
  throw new Error('GitLab repository directory exceeds the safe pagination limit')
}
