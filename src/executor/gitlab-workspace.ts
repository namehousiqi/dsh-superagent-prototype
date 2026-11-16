/** GitLab Ticket workspace preparation and fail-closed recovery. */
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { TicketRepository } from '../app/ticket-repository.ts'

type GitlabTicket = Extract<TicketRepository, { provider: 'gitlab' }>
type Git = (args: string[], cwd: string) => Promise<string>

/** Clone only the selected development branch; retain the resulting SHA before launching a worker. */
export async function prepareGitlabWorkspace(snapshot: GitlabTicket, directory: string, git: Git,
  save: (snapshot: GitlabTicket) => void): Promise<void> {
  if (snapshot.baseSha) throw new Error('A saved base requires the existing workspace; refusing to create a replacement')
  if (snapshot.featureBranch === snapshot.baseBranch || snapshot.featureBranch === snapshot.targetBranch) throw new Error('Feature branch conflicts with a configured branch')
  await mkdir(dirname(directory), { recursive: true })
  await git(['check-ref-format', '--branch', snapshot.featureBranch], dirname(directory))
  await git(['clone', '--no-checkout', '--single-branch', `--branch=${snapshot.baseBranch}`, '--', snapshot.cloneUrl, directory], dirname(directory))
  const sha = (await git(['-C', directory, 'rev-parse', '--verify', 'HEAD^{commit}'], dirname(directory))).trim()
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) throw new Error('Git returned an invalid base commit SHA')
  await git(['-C', directory, 'checkout', '-b', snapshot.featureBranch, sha], dirname(directory))
  save({ ...snapshot, baseSha: sha })
}

/** Refuse uncertain or altered workspaces; never reset, recreate, or switch an existing branch. */
export async function verifyGitlabWorkspace(snapshot: GitlabTicket, directory: string, git: Git): Promise<void> {
  if (!snapshot.baseSha || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(snapshot.baseSha)) throw new Error('Ticket base commit is missing or invalid')
  const run = (args: string[]) => git(['-C', directory, ...args], dirname(directory))
  const origin = (await run(['remote', 'get-url', '--push', 'origin'])).trim()
  if (origin !== snapshot.cloneUrl) throw new Error('Ticket workspace origin does not match its fixed repository')
  const branch = (await run(['branch', '--show-current'])).trim()
  if (branch !== snapshot.featureBranch) throw new Error('Ticket workspace is not on its fixed feature branch')
  await run(['merge-base', '--is-ancestor', snapshot.baseSha, 'HEAD'])
}
