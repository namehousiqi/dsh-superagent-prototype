import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareGitlabWorkspace, verifyGitlabWorkspace } from '../src/executor/gitlab-workspace.ts'
import { pushGitlabBranch, type PushState } from '../src/executor/gitlab-push.ts'
import { ticketRepository } from '../src/app/ticket-repository.ts'
import { testGitlabDeployment } from './fixtures/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
let root: string, remote: string, seed: string, workspace: string
const git = async (args: string[], cwd = root) => (await exec('git', args, { cwd, env: gitEnv({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }) })).stdout
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gitlab-workspace-'))
  remote = join(root, 'remote.git'); seed = join(root, 'seed'); workspace = join(root, 'ticket')
  await git(['init', '--bare', remote]); await git(['init', '-b', 'develop', seed])
  await git(['-C', seed, 'config', 'user.name', 'Test']); await git(['-C', seed, 'config', 'user.email', 'test@example.test'])
  await writeFile(join(seed, 'file.txt'), 'base\n'); await git(['-C', seed, 'add', 'file.txt'])
  await git(['-C', seed, 'commit', '-m', 'base']); await git(['-C', seed, 'remote', 'add', 'origin', remote])
  await git(['-C', seed, 'push', 'origin', 'develop']); await git(['-C', seed, 'branch', 'release']); await git(['-C', seed, 'push', 'origin', 'release'])
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('GitLab workspace', () => {
  it('starts at the fixed base, records its SHA and preserves it on subsequent checks', async () => {
    const source = ticketRepository(testGitlabDeployment(), 'task-123')
    if (source.provider !== 'gitlab') throw new Error('expected GitLab')
    const snapshot = { ...source, cloneUrl: remote }
    let saved = snapshot
    await prepareGitlabWorkspace(snapshot, workspace, git, next => { saved = next })
    expect(saved.baseSha).toMatch(/^[0-9a-f]{40,64}$/)
    expect((await git(['-C', workspace, 'branch', '--show-current'])).trim()).toBe(snapshot.featureBranch)
    expect((await git(['-C', workspace, 'rev-parse', 'HEAD'])).trim()).toBe(saved.baseSha)
    await verifyGitlabWorkspace(saved, workspace, git)
    await git(['-C', workspace, 'checkout', '-b', 'release'])
    await expect(verifyGitlabWorkspace(saved, workspace, git)).rejects.toThrow(/branch/i)
  })
  it('rejects an existing directory with no saved base and never overwrites it', async () => {
    const source = ticketRepository(testGitlabDeployment(), 'task-123')
    if (source.provider !== 'gitlab') throw new Error('expected GitLab')
    await expect(verifyGitlabWorkspace(source, seed, git)).rejects.toThrow(/base/i)
  })
  it('pushes only the Ticket branch and reconciles a lost response without touching base or target', async () => {
    const source = ticketRepository(testGitlabDeployment(), 'task-123')
    if (source.provider !== 'gitlab') throw new Error('expected GitLab')
    let snapshot = { ...source, cloneUrl: remote }, state: PushState | undefined
    await prepareGitlabWorkspace(snapshot, workspace, git, next => { snapshot = next })
    await git(['-C', workspace, 'config', 'user.name', 'Test']); await git(['-C', workspace, 'config', 'user.email', 'test@example.test'])
    await writeFile(join(workspace, 'file.txt'), 'changed\n'); await git(['-C', workspace, 'add', 'file.txt']); await git(['-C', workspace, 'commit', '-m', 'feature'])
    const head = (await git(['-C', workspace, 'rev-parse', 'HEAD'])).trim()
    let failAfterPush = true
    const unreliableGit = async (args: string[], cwd: string) => {
      const result = await git(args, cwd)
      if (args.includes('push') && failAfterPush) { failAfterPush = false; throw new Error('lost response') }
      return result
    }
    await expect(pushGitlabBranch(snapshot, workspace, unreliableGit, () => state, next => { state = next }, () => {})).rejects.toThrow('lost response')
    expect(state).toEqual({ pendingSha: head })
    await expect(pushGitlabBranch(snapshot, workspace, git, () => state, next => { state = next }, () => {})).resolves.toBe(head)
    expect(state).toEqual({ lastSha: head })
    expect((await git(['--git-dir', remote, 'rev-parse', `refs/heads/${snapshot.featureBranch}`])).trim()).toBe(head)
    expect((await git(['--git-dir', remote, 'rev-parse', 'refs/heads/develop'])).trim()).toBe(snapshot.baseSha)
    expect((await git(['--git-dir', remote, 'rev-parse', 'refs/heads/release'])).trim()).toBe(snapshot.baseSha)
  })
  it('rejects a remote branch created concurrently between preflight and push', async () => {
    const source = ticketRepository(testGitlabDeployment(), 'task-123')
    if (source.provider !== 'gitlab') throw new Error('expected GitLab')
    let snapshot = { ...source, cloneUrl: remote }, state: PushState | undefined
    await prepareGitlabWorkspace(snapshot, workspace, git, next => { snapshot = next })
    await git(['-C', workspace, 'config', 'user.name', 'Test']); await git(['-C', workspace, 'config', 'user.email', 'test@example.test'])
    await writeFile(join(workspace, 'file.txt'), 'changed\n'); await git(['-C', workspace, 'add', 'file.txt']); await git(['-C', workspace, 'commit', '-m', 'feature'])
    const concurrentGit = async (args: string[], cwd: string) => {
      if (args.includes('push')) await git(['--git-dir', remote, 'update-ref', `refs/heads/${snapshot.featureBranch}`, snapshot.baseSha!])
      return git(args, cwd)
    }
    await expect(pushGitlabBranch(snapshot, workspace, concurrentGit, () => state, next => { state = next }, () => {})).rejects.toThrow()
    expect((await git(['--git-dir', remote, 'rev-parse', `refs/heads/${snapshot.featureBranch}`])).trim()).toBe(snapshot.baseSha)
    await expect(pushGitlabBranch(snapshot, workspace, git, () => state, next => { state = next }, () => {})).rejects.toThrow(/changed outside/)
  })
  it.each(['url.https://other.test/.pushInsteadOf', 'http.sslVerify'])('rejects unsafe local Git configuration %s before push', async name => {
    const source = ticketRepository(testGitlabDeployment(), 'task-123')
    if (source.provider !== 'gitlab') throw new Error('expected GitLab')
    let snapshot = { ...source, cloneUrl: remote }
    await prepareGitlabWorkspace(snapshot, workspace, git, next => { snapshot = next })
    await git(['-C', workspace, 'config', 'user.name', 'Test']); await git(['-C', workspace, 'config', 'user.email', 'test@example.test'])
    await writeFile(join(workspace, 'file.txt'), 'changed\n'); await git(['-C', workspace, 'add', 'file.txt']); await git(['-C', workspace, 'commit', '-m', 'feature'])
    await git(['-C', workspace, 'config', name, name === 'http.sslVerify' ? 'false' : remote])
    await expect(pushGitlabBranch(snapshot, workspace, git, () => undefined, () => {}, () => {})).rejects.toThrow(/unsafe local Git configuration/)
    expect((await git(['--git-dir', remote, 'branch', '--list', snapshot.featureBranch])).trim()).toBe('')
  })
  it('refuses a preexisting feature branch that this Ticket has not published', async () => {
    const source = ticketRepository(testGitlabDeployment(), 'task-123')
    if (source.provider !== 'gitlab') throw new Error('expected GitLab')
    let snapshot = { ...source, cloneUrl: remote }
    await prepareGitlabWorkspace(snapshot, workspace, git, next => { snapshot = next })
    await git(['-C', workspace, 'config', 'user.name', 'Test']); await git(['-C', workspace, 'config', 'user.email', 'test@example.test'])
    await writeFile(join(workspace, 'file.txt'), 'changed\n'); await git(['-C', workspace, 'add', 'file.txt']); await git(['-C', workspace, 'commit', '-m', 'feature'])
    await git(['-C', seed, 'push', 'origin', `develop:refs/heads/${snapshot.featureBranch}`])
    await expect(pushGitlabBranch(snapshot, workspace, git, () => undefined, () => {}, () => {})).rejects.toThrow(/already exists/)
    expect((await git(['--git-dir', remote, 'rev-parse', `refs/heads/${snapshot.featureBranch}`])).trim()).toBe(snapshot.baseSha)
  })
  it('refuses a changed push origin and refuses to recreate a workspace after its SHA was recorded', async () => {
    const source = ticketRepository(testGitlabDeployment(), 'task-123')
    if (source.provider !== 'gitlab') throw new Error('expected GitLab')
    let saved = { ...source, cloneUrl: remote }
    await prepareGitlabWorkspace(saved, workspace, git, next => { saved = next })
    await expect(prepareGitlabWorkspace(saved, join(root, 'replacement'), git, () => {})).rejects.toThrow(/existing workspace/i)
    await git(['-C', workspace, 'remote', 'set-url', '--push', 'origin', 'https://other.test/group/project.git'])
    await expect(verifyGitlabWorkspace(saved, workspace, git)).rejects.toThrow(/origin/i)
  })
})
