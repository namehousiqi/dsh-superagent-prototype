/** Repository identity fixed in the Ticket creation transaction. */
import type { Deployment } from '../deployment.ts'

export type TicketRepository =
  | { provider: 'github'; repository: string }
  | { provider: 'gitlab'; host: string; projectId: number; repository: string; cloneUrl: string; baseBranch: string; targetBranch: string; featureBranch: string; baseSha?: string }

export function ticketRepository(deployment: Deployment, name: string): TicketRepository {
  if (deployment.provider === 'github') {
    if (!deployment.github) throw new Error('GitHub account is unavailable')
    return { provider: 'github', repository: deployment.repository }
  }
  const project = deployment.gitlab
  if (!project) throw new Error('GitLab project is unavailable')
  return { provider: 'gitlab', host: project.host, projectId: project.projectId, repository: project.repository,
    cloneUrl: project.cloneUrl, baseBranch: project.baseBranch, targetBranch: project.targetBranch, featureBranch: `agent/${name}` }
}

export function canUseTicketRepository(snapshot: TicketRepository | undefined, deployment: Deployment, legacyRepositoryChanged: boolean): boolean {
  if (snapshot) return sameRepository(snapshot, deployment)
  return deployment.provider === 'github' && !legacyRepositoryChanged
}

/** Reject a resumed Ticket when the running instance points at a different repository. */
export function sameRepository(snapshot: TicketRepository, deployment: Deployment): boolean {
  if (snapshot.provider !== deployment.provider) return false
  if (snapshot.provider === 'github') return snapshot.repository.toLowerCase() === deployment.repository.toLowerCase()
  const project = deployment.gitlab
  return !!project && snapshot.host === project.host && snapshot.projectId === project.projectId && snapshot.cloneUrl === project.cloneUrl
}
