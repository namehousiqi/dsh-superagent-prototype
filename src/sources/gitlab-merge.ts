/** GitLab merge request identity and idempotent creation for a single Ticket branch. */
import { z } from 'zod'
import type { GitLabProject } from '../deployment.ts'
import type { TicketRepository } from '../app/ticket-repository.ts'
import type { Commands } from '../infra/commands.ts'

const MergeRequestSchema = z.object({
  iid: z.number().int().positive(), project_id: z.number().int().positive(),
  source_project_id: z.number().int().positive(), target_project_id: z.number().int().positive(),
  source_branch: z.string(), target_branch: z.string(), author: z.object({ username: z.string().min(1) }),
  state: z.enum(['opened', 'closed', 'merged', 'locked']), sha: z.string().nullish(),
  merged_at: z.string().nullish(), closed_at: z.string().nullish(),
})
export type GitlabMergeRequest = z.infer<typeof MergeRequestSchema>
type GitlabTicket = Extract<TicketRepository, { provider: 'gitlab' }>
type Api = Pick<Commands, 'gitlabApi' | 'deployment'>

function verifyProject(api: Api, ticket: GitlabTicket, project: GitLabProject): void {
  const current = api.deployment.gitlab
  if (api.deployment.provider !== 'gitlab' || !current || current.host !== ticket.host || current.projectId !== ticket.projectId
    || current.cloneUrl !== ticket.cloneUrl || current.username !== project.username || current.webUrl !== project.webUrl
    || project.host !== ticket.host || project.projectId !== ticket.projectId || project.cloneUrl !== ticket.cloneUrl) {
    throw new Error('GitLab project does not match this Ticket')
  }
}

/** Reject cross-project, cross-branch, foreign-author, or otherwise mismatched merge requests. */
export function verifyMergeRequest(mr: GitlabMergeRequest, ticket: GitlabTicket, project: GitLabProject): void {
  if (project.host !== ticket.host || project.projectId !== ticket.projectId || project.cloneUrl !== ticket.cloneUrl
    || mr.project_id !== ticket.projectId || mr.source_project_id !== ticket.projectId || mr.target_project_id !== ticket.projectId
    || mr.source_branch !== ticket.featureBranch || mr.target_branch !== ticket.targetBranch
    || mr.author.username.toLowerCase() !== project.username.toLowerCase()) {
    throw new Error('GitLab merge request does not belong to this Ticket, project, branch, target and agent')
  }
}

export async function readMergeRequest(api: Api, iid: number, ticket: GitlabTicket, project: GitLabProject): Promise<GitlabMergeRequest> {
  verifyProject(api, ticket, project)
  if (!Number.isSafeInteger(iid) || iid <= 0) throw new Error('Invalid GitLab merge request IID')
  const mr = await api.gitlabApi(MergeRequestSchema, `merge_requests/${iid}`)
  if (mr.iid !== iid) throw new Error('GitLab returned a different merge request IID')
  verifyMergeRequest(mr, ticket, project)
  return mr
}

/** A lost create response is recovered by the next lookup; a conflicting MR is never modified. */
export async function ensureMergeRequest(api: Api, ticket: GitlabTicket, project: GitLabProject, title: string, description: string,
  authorize: () => void = () => {}): Promise<GitlabMergeRequest> {
  verifyProject(api, ticket, project)
  if (!title.trim()) throw new Error('Merge request title is required')
  const found: GitlabMergeRequest[] = []
  for (let page = 1; page <= 100; page++) {
    const batch = await api.gitlabApi(z.array(MergeRequestSchema), 'merge_requests', {
      query: { state: 'opened', scope: 'all', source_branch: ticket.featureBranch, per_page: '100', page: String(page) },
    })
    found.push(...batch.filter(mr => mr.source_branch === ticket.featureBranch))
    if (batch.length < 100) break
    if (page === 100) throw new Error('Too many GitLab merge requests to safely determine branch ownership')
  }
  if (found.length > 1) throw new Error('Multiple open GitLab merge requests use this Ticket branch')
  if (found.length) {
    verifyMergeRequest(found[0]!, ticket, project)
    return found[0]!
  }
  authorize()
  const created = await api.gitlabApi(MergeRequestSchema, 'merge_requests', { method: 'POST', fields: {
    source_branch: ticket.featureBranch, target_branch: ticket.targetBranch, title, description,
  } })
  verifyMergeRequest(created, ticket, project)
  if (created.state !== 'opened') throw new Error('Created GitLab merge request is not open')
  return created
}

/** Construct the link from trusted configuration, not an API-provided URL. */
export function mergeRequestUrl(project: GitLabProject, iid: number): string {
  if (!Number.isSafeInteger(iid) || iid <= 0) throw new Error('Invalid GitLab merge request IID')
  return `${project.webUrl.replace(/\/$/, '')}/-/merge_requests/${iid}`
}
