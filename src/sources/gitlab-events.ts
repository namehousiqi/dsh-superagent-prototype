/** Normalize only the pipeline for the MR's current source commit. */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import type { GitLabProject } from '../deployment.ts'
import { mergeRequestUrl } from './gitlab-merge.ts'

export const PipelineSchema = z.object({ id: z.number().int().positive(), sha: z.string(), status: z.string() })
export type Pipeline = z.infer<typeof PipelineSchema>
export type PipelineState = 'unknown' | 'pending' | 'passed' | 'failed' | 'cancelled' | 'manual' | 'skipped'
export function pipelineState(headSha: string | null | undefined, pipeline: Pipeline | null | undefined): PipelineState {
  if (!headSha || !pipeline || pipeline.sha !== headSha) return 'unknown'
  switch (pipeline.status) {
    case 'success': return 'passed'
    case 'failed': return 'failed'
    case 'canceled': return 'cancelled'
    case 'manual': return 'manual'
    case 'skipped': return 'skipped'
    case 'created': case 'waiting_for_resource': case 'preparing': case 'pending': case 'running': case 'scheduled': return 'pending'
    default: return 'unknown'
  }
}

/** A stable thread identity includes the instance and project, not just the project-local IID. */
export function gitlabThread(project: Pick<GitLabProject, 'host' | 'projectId'>, iid: number): string {
  if (!Number.isSafeInteger(iid) || iid < 1) throw new Error('Invalid GitLab merge request IID')
  return `${project.host}:${project.projectId}:${iid}`
}

export const NoteSchema = z.object({
  id: z.number().int().positive(), body: z.string().nullable(), system: z.boolean(),
  created_at: z.string(), updated_at: z.string(), author: z.object({ username: z.string(), bot: z.boolean().optional() }),
  position: z.object({ new_path: z.string().nullish(), old_path: z.string().nullish(),
    new_line: z.number().int().positive().nullish(), old_line: z.number().int().positive().nullish() }).nullish(),
})
export type GitlabNote = z.infer<typeof NoteSchema>

/** Use the configured project URL; note text and author are untrusted source data. */
export function noteTrigger(project: GitLabProject, iid: number, note: GitlabNote, discussion?: string): Trigger {
  const thread = gitlabThread(project, iid)
  const url = `${mergeRequestUrl(project, iid)}#note_${note.id}`
  const position = note.position
  const path = position?.new_line ? position.new_path ?? position.old_path
    : position?.old_line ? position.old_path ?? position.new_path : position?.new_path ?? position?.old_path
  const line = position?.new_line ?? position?.old_line
  const place = path ? `${path}${line ? `:${line}` : ''}` : ''
  const text = note.body && place ? `${place}\n${note.body}` : note.body ?? ''
  return { id: key('gitlab-note', thread, String(note.id), note.updated_at), source: 'gitlab',
    threads: [{ source: 'gitlab', id: thread }], actor: { source: 'gitlab', id: note.author.username },
    human: !note.system && !note.author.bot && note.author.username.toLowerCase() !== project.username.toLowerCase(),
    at: note.updated_at || note.created_at, text, url,
    channel: { source: 'gitlab', thread: `gitlab:${thread}`, address: { iid: String(iid), url, ...discussion ? { discussion } : {} } },
    meta: { iid, projectId: project.projectId, noteId: note.id, system: note.system } }
}
