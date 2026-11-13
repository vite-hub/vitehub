import { createHash } from 'node:crypto'
import * as v from 'valibot'
import type { Claim, PullRequestInbox } from './store.ts'
import type { GitHubEvidence } from './types.ts'
import { isBabysitterCheckRun } from '../check-run.ts'
import { compactCiLog, diagnosticExcerpt } from '../../github/ci-logs.ts'
const jobSchema = v.looseObject({ id: v.number(), run_id: v.number(), head_sha: v.string(), status: v.string(), conclusion: v.nullish(v.string()),
  name: v.optional(v.string()), run_attempt: v.optional(v.number()), completed_at: v.nullish(v.string()), updated_at: v.nullish(v.string()),
  steps: v.optional(v.array(v.object({ name: v.string(), number: v.number(), conclusion: v.nullish(v.string()), started_at: v.nullish(v.string()), completed_at: v.nullish(v.string()) }))) })
type ActionJob = v.InferOutput<typeof jobSchema>
type CiEvidence = Record<string, unknown>
const metadataSchema = v.object({ value: v.object({ jobs: v.optional(v.array(jobSchema)), error: v.optional(v.string()) }), retryAt: v.optional(v.number()), fetchedAt: v.optional(v.number()) })
const logSchema = v.object({ value: v.object({ log: v.optional(v.string()), error: v.optional(v.string()) }), retryAt: v.optional(v.number()), fetchedAt: v.optional(v.number()) })

export type CiEvidenceReaders = {
  readJson: (path: string, projection?: string) => Promise<unknown[]>
  readLog: (path: string, repository: string) => Promise<string>
}
const failures = new Set(['failure', 'timed_out', 'startup_failure', 'action_required', 'cancelled', 'stale'])
const key = (kind: string, value: unknown) => `ci-evidence:v1:${kind}:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
export const failed = (item: Pick<GitHubEvidence, 'status' | 'conclusion'>) => item.status === 'completed' && failures.has(item.conclusion ?? '')
const sourceUrl = (repository: string, job: ActionJob) => `https://github.com/${repository}/actions/runs/${job.run_id}/job/${job.id}`

/**
 * The run of one check that counts: the newer one, unless it was cancelled beside a finished run. On
 * onmax/comark-plugins#87 and #103 the push and pull_request runs of one workflow shared a concurrency
 * group, the later one was cancelled, and the PRs waited 17 h on checks that had already passed.
 */
export function newestCheckRun<T extends { id?: unknown; status?: unknown; state?: unknown; conclusion?: unknown }>(previous: T | undefined, check: T): T {
  if (!previous) return check
  const [newer, older] = Number(check.id ?? 0) >= Number(previous.id ?? 0) ? [check, previous] : [previous, check]
  const cancelled = (run: T) => String(run.conclusion ?? run.state) === 'cancelled'
  return cancelled(newer) && !cancelled(older) && older.status === 'completed' ? older : newer
}

export function actionLocation(repository: string, check: GitHubEvidence): { runId: number; jobId?: number } | undefined {
  if (check.app?.slug && check.app.slug !== 'github-actions') return undefined
  for (const value of [check.html_url, check.details_url]) {
    if (typeof value !== 'string') continue
    let url: URL
    try { url = new URL(value) } catch { continue }
    if (url.hostname !== 'github.com') continue
    const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?\/?$/)
    if (match && match[1]?.toLowerCase() === repository.toLowerCase()) {
      const location: { runId: number; jobId?: number } = { runId: Number(match[2]) }
      if (match[3]) location.jobId = Number(match[3])
      return location
    }
  }
  return undefined
}

/** Fetch failed job evidence before invoking the model. */
export async function hydrateFailedCiEvidence(inbox: PullRequestInbox, claim: Claim, readers: CiEvidenceReaders, now = Date.now()) {
  const { repository } = claim.snapshot, headSha = claim.snapshot.pr?.head?.sha
  const evidence: CiEvidence[] = [], seenJobs = new Set<number>()
  let remaining = 48_000
  for (const check of Object.values(claim.snapshot.checks)) {
    if (!headSha || check.head_sha !== headSha || !failed(check) || isBabysitterCheckRun(check)) continue
    const common = { checkId: check.id, checkName: check.name, headSha, conclusion: check.conclusion, sourceURL: check.details_url ?? check.html_url }
    const location = actionLocation(repository, check)
    if (!location) {
      evidence.push({ ...common, status: 'unsupported', reason: 'No GitHub Actions job/run link; this check may be supplied by an external reviewer.', sourceURL: check.details_url ?? check.html_url })
      continue
    }
    if (location.jobId && seenJobs.has(location.jobId)) continue
    const metadataKey = key('jobs', [repository, check.id, location, headSha, check.run_attempt, check.completed_at ?? check.updated_at, check.conclusion])
    const parsedMetadata = v.safeParse(metadataSchema, await inbox.meta(metadataKey))
    let metadata = parsedMetadata.success ? parsedMetadata.output : undefined
    if (!metadata || metadata.retryAt !== undefined && metadata.retryAt <= now) {
      try {
        const jobs = location.jobId
          ? await readers.readJson(`repos/${repository}/actions/jobs/${location.jobId}`, '.')
          : await readers.readJson(`repos/${repository}/actions/runs/${location.runId}/jobs?filter=latest&per_page=100`, '.jobs[]')
        const parsedJobs = jobs.map(job => v.parse(jobSchema, job))
        metadata = { value: { jobs: parsedJobs }, fetchedAt: now }
        if (!parsedJobs.length || parsedJobs.some(job => job.status !== 'completed')) metadata.retryAt = now + 120_000
      } catch {
        metadata = { value: { error: 'GitHub Actions job metadata unavailable; this is an API read failure, not a CI result.' }, retryAt: now + 120_000, fetchedAt: now }
      }
      await inbox.setMeta(metadataKey, metadata)
    }
    if (metadata.value.error) { evidence.push({ ...common, status: 'unavailable', reason: metadata.value.error, retryAt: metadata.retryAt }); continue }
    const jobs = metadata.value.jobs ?? []
    let matched = false
    for (const job of jobs) {
      if (job.head_sha !== headSha || !failed(job) || !Number.isSafeInteger(job.id) || !Number.isSafeInteger(job.run_id)) continue
      matched = true
      if (seenJobs.has(job.id)) continue
      seenJobs.add(job.id)
      const logKey = key('job-log', [repository, job.id, job.run_attempt, job.completed_at ?? job.updated_at])
      const parsedLog = v.safeParse(logSchema, await inbox.meta(logKey))
      let cached = parsedLog.success ? parsedLog.output : undefined
      if (!cached || cached.retryAt !== undefined && cached.retryAt <= now) {
        try {
          const log = await readers.readLog(`repos/${repository}/actions/jobs/${job.id}/logs`, repository)
          if (!log) throw new Error('Empty log response')
          cached = { value: { log: compactCiLog(log) }, fetchedAt: now }
        } catch {
          cached = { value: { error: 'Job log unavailable or expired; this is an API read failure, not an additional CI failure.' }, retryAt: now + 120_000, fetchedAt: now }
        }
        await inbox.setMeta(logKey, cached)
      }
      const failedSteps = (job.steps ?? []).filter((step) => failures.has(step.conclusion ?? '')).map((step) => ({ name: step.name, number: step.number, conclusion: step.conclusion, startedAt: step.started_at, completedAt: step.completed_at }))
      const base = { ...common, jobId: job.id, runId: job.run_id, runAttempt: job.run_attempt, jobName: job.name, failedSteps, sourceURL: sourceUrl(repository, job), fetchedAt: new Date(cached.fetchedAt ?? now).toISOString() }
      if (cached.value.log !== undefined) {
        const excerpt = diagnosticExcerpt(cached.value.log, Math.min(16_000, remaining), failedSteps.map(step => step.name))
        remaining -= excerpt.excerpt.length
        evidence.push({ ...base, status: 'available', ...excerpt, fullLogCached: true, cacheKey: logKey })
      } else evidence.push({ ...base, status: 'unavailable', reason: cached.value.error, retryAt: cached.retryAt })
    }
    if (!matched) evidence.push({ ...common, status: 'unavailable', reason: 'No completed failed job matched the current PR head; pending, skipped, successful and other-head jobs were not downloaded.', sourceURL: check.html_url })
  }
  // A webhook received during I/O wins, including pending-check revisions.
  return inbox.hydrate(claim, { ciEvidence: evidence })
}
