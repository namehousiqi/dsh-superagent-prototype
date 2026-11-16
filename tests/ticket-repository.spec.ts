import { describe, expect, it } from 'vitest'
import { canUseTicketRepository, sameRepository, ticketRepository } from '../src/app/ticket-repository.ts'
import { testDeployment, testGitlabDeployment } from './fixtures/deployment.ts'

describe('Ticket repository identity', () => {
  it('fixes GitLab project, independent branches and the Ticket feature branch', () => {
    const deployment = testGitlabDeployment()
    const snapshot = ticketRepository(deployment, 'fix-example-123')
    expect(snapshot).toMatchObject({ provider: 'gitlab', host: 'git.example.test', projectId: 42,
      repository: 'group/project', baseBranch: 'develop', targetBranch: 'release', featureBranch: 'agent/fix-example-123' })
    expect(sameRepository(snapshot, deployment)).toBe(true)
    expect(sameRepository(snapshot, testGitlabDeployment({ gitlab: { ...deployment.gitlab, baseBranch: 'new-base', targetBranch: 'new-target' } }))).toBe(true)
    expect(sameRepository(snapshot, testGitlabDeployment({ gitlab: { ...deployment.gitlab, projectId: 43 } }))).toBe(false)
    expect(sameRepository(snapshot, testGitlabDeployment({ gitlab: { ...deployment.gitlab, host: 'other.test' } }))).toBe(false)
    expect(sameRepository(snapshot, testDeployment())).toBe(false)
  })
  it('blocks legacy Tickets after a repository change while preserving snapshots and unchanged GitHub installations', () => {
    const github = testDeployment(), snapshot = ticketRepository(github, 'fix')
    expect(canUseTicketRepository(undefined, github, false)).toBe(true)
    expect(canUseTicketRepository(undefined, github, true)).toBe(false)
    expect(canUseTicketRepository(undefined, testGitlabDeployment(), false)).toBe(false)
    expect(canUseTicketRepository(snapshot, github, true)).toBe(true)
    expect(canUseTicketRepository(snapshot, testDeployment({ repository: 'other/repo' }), true)).toBe(false)
  })
  it('keeps GitHub repository matching case-insensitive and rejects other providers', () => {
    const snapshot = ticketRepository(testDeployment(), 'fix-example')
    expect(sameRepository(snapshot, testDeployment({ repository: 'ACME/Widgets' }))).toBe(true)
    expect(sameRepository(snapshot, testDeployment({ repository: 'acme/other' }))).toBe(false)
    expect(sameRepository(snapshot, testGitlabDeployment())).toBe(false)
  })
})
