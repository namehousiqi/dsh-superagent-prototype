import { expect, it } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { ticketRepository } from '../src/app/ticket-repository.ts'
import { ticketEnvironment } from '../src/app/execution-environment.ts'
import { SettingsSchema } from '../src/policy.ts'
import { gitlabKind } from '../src/sources/gitlab.ts'
import type { SourceRegistry } from '../src/sources/registry.ts'
import { testGitlabDeployment } from './fixtures/deployment.ts'

it('exposes the Ticket fixed GitLab branches and base SHA even after configuration changes', () => {
  const deployment = testGitlabDeployment(), initial = ticketRepository(deployment, 'fix-123')
  if (initial.provider !== 'gitlab') throw new Error('expected GitLab')
  const repository = { ...initial, baseSha: 'a'.repeat(40) }
  const changed = testGitlabDeployment({ gitlab: { ...deployment.gitlab, baseBranch: 'new-base', targetBranch: 'new-target' } })
  const sources = { environments: () => [{ kind: gitlabKind, environment: gitlabKind.environment!, config: {} }] } as unknown as SourceRegistry
  const ticket = { id: 't1', execution: { name: 'fix-123', directory: '/work/fix-123', assignment: '' } } as Ticket
  const vars = Object.fromEntries(ticketEnvironment({ deployment: changed, sources, settings: SettingsSchema.parse({}), ticket, repository })
    .map(v => [v.key, v.value]))
  expect(vars).toMatchObject({ DSH_SUPERAGENT_GITLAB_REPOSITORY: repository.cloneUrl, DSH_SUPERAGENT_GITLAB_BASE: 'develop',
    DSH_SUPERAGENT_GITLAB_TARGET: 'release', DSH_SUPERAGENT_GITLAB_BRANCH: 'agent/fix-123', DSH_SUPERAGENT_GITLAB_BASE_SHA: 'a'.repeat(40) })
})
