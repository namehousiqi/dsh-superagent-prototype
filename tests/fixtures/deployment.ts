/** Default deployment and machine fixtures for tests. */
import type { Volatile } from '@deepseek-ai/cordis'
import type { GithubDeployment, GitlabDeployment, Machine } from '../../src/deployment.ts'

/** Mutable Volatile reference for simulating live configuration updates. */
export const reference = <T>(value: T): Volatile<T> & { set(next: T): void } => {
  let current = value
  return { get: () => current as never, set: next => { current = next } }
}
export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  stateDir: '/tmp/dsh-superagent-test', promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
  admissionContextTimeoutMs: reference(15000), ...overrides,
})
export const testDeployment = (overrides: Partial<GithubDeployment> = {}): GithubDeployment => ({
  ...testMachine(), provider: 'github', repository: 'acme/widgets',
  github: { cli: '/bin/false', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' },
  feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' },
  ...overrides,
})
export const testGitlabDeployment = (overrides: Partial<GitlabDeployment> = {}): GitlabDeployment => ({
  ...testMachine(), provider: 'gitlab', repository: 'group/project',
  gitlab: { cli: '/bin/false', host: 'git.example.test', projectId: 42, repository: 'group/project',
    webUrl: 'https://git.example.test/group/project', cloneUrl: 'https://git.example.test/group/project.git',
    username: 'agent-bot', baseBranch: 'develop', targetBranch: 'release' },
  ...overrides,
})
