import { describe, expect, it } from 'vitest'
import { gitlabThread, noteTrigger, pipelineState } from '../src/sources/gitlab-events.ts'
import { testGitlabDeployment } from './fixtures/deployment.ts'

describe('GitLab MR events', () => {
  const pipeline = { id: 1, sha: 'head', status: 'success' }
  it('never treats an absent or stale pipeline as passing', () => {
    expect(pipelineState('head', null)).toBe('unknown')
    expect(pipelineState('new-head', pipeline)).toBe('unknown')
    expect(pipelineState(null, pipeline)).toBe('unknown')
    expect(pipelineState('head', pipeline)).toBe('passed')
    expect(pipelineState('head', { ...pipeline, status: 'running' })).toBe('pending')
    expect(pipelineState('head', { ...pipeline, status: 'failed' })).toBe('failed')
    expect(pipelineState('head', { ...pipeline, status: 'skipped' })).toBe('skipped')
    expect(pipelineState('head', { ...pipeline, status: 'manual' })).toBe('manual')
    expect(pipelineState('head', { ...pipeline, status: 'new-status' })).toBe('unknown')
  })
  it('separates same-IID threads across instances and projects', () => {
    expect(gitlabThread({ host: 'git.test', projectId: 1 }, 7)).not.toBe(gitlabThread({ host: 'git.test', projectId: 2 }, 7))
    expect(gitlabThread({ host: 'git.test', projectId: 1 }, 7)).not.toBe(gitlabThread({ host: 'other.test', projectId: 1 }, 7))
    expect(() => gitlabThread({ host: 'git.test', projectId: 1 }, 0)).toThrow(/Invalid/)
  })
  it('uses the old path for comments on deleted lines', () => {
    const note = { id: 13, body: 'Why remove this?', system: false, created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z', author: { username: 'reviewer' },
      position: { old_path: 'old.ts', new_path: 'new.ts', old_line: 5, new_line: null } }
    expect(noteTrigger(testGitlabDeployment().gitlab, 7, note).text).toBe('old.ts:5\nWhy remove this?')
  })
  it('deduplicates a note revision and classifies agent, bot and system notes as nonhuman', () => {
    const project = testGitlabDeployment().gitlab
    const note = { id: 12, body: 'Please fix', system: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', author: { username: 'reviewer' } }
    const trigger = noteTrigger(project, 7, note)
    expect(trigger.human).toBe(true)
    expect(trigger.id).toBe(noteTrigger(project, 7, note).id)
    expect(trigger.id).not.toBe(noteTrigger(project, 7, { ...note, updated_at: '2026-01-02T00:00:00Z' }).id)
    expect(trigger.url).toBe(`${project.webUrl}/-/merge_requests/7#note_12`)
    expect(noteTrigger(project, 7, { ...note, system: true }).human).toBe(false)
    expect(noteTrigger(project, 7, { ...note, author: { username: 'bot', bot: true } }).human).toBe(false)
    expect(noteTrigger(project, 7, { ...note, author: { username: project.username.toUpperCase() } }).human).toBe(false)
  })
})
