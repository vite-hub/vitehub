import { createHash } from 'node:crypto'
import * as v from 'valibot'
import type { Claim, PullRequestInbox } from './store.ts'
import type { GitHubEvidence } from './types.ts'
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

/** Bound log context explicitly; the full fetched log remains in the local cache. */
export function diagnosticExcerpt(log: string, limit = 16_000, failedSteps: string[] = []) {
  const lines = log.split('\n')
  if (log.length <= limit) return { excerpt: log, complete: true, totalLines: lines.length, includedLineRanges: [[1, lines.length]], partialLines: [] }
  const wanted = new Set<number>(), anchors = new Set<number>()
  const mark = (line: number) => { for (let n = Math.max(0, line - 4); n <= Math.min(lines.length - 1, line + 5); n++) wanted.add(n) }
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!
    if (/##\[error\]|\berror(?:\s|:|\[)|\bFAIL(?:ED)?\b|TypeError|AssertionError|exit code [1-9]|ELIFECYCLE|ERR_/i.test(line)
      || failedSteps.some(step => step && line.includes(step))) { anchors.add(n); mark(n) }
  }
  if (!wanted.size) for (let n = Math.max(0, lines.length - 80); n < lines.length; n++) wanted.add(n)
  const selected = new Map<number, string>(), included: number[] = [], partialLines: number[] = []
  let remaining = Math.max(0, limit)
  // Failure diagnostics are commonly emitted at the end of a job. Select the
  // newest diagnostic windows first, then restore source order for the excerpt.
  // This keeps a late assertion or exit-code line when an early warning-heavy
  // section would otherwise consume the entire budget.
  for (const n of [...anchors].sort((a, b) => b - a).concat([...wanted].filter(n => !anchors.has(n)).sort((a, b) => b - a))) {
    const prefix = selected.size ? '\n' : ''
    if (remaining <= prefix.length) break
    const line = lines[n]!, content = line.slice(0, remaining - prefix.length)
    selected.set(n + 1, content); included.push(n + 1); remaining -= prefix.length + content.length
    if (content.length < line.length) { partialLines.push(n + 1); break }
  }
  included.sort((a, b) => a - b)
  const chunks = included.map(lineNumber => selected.get(lineNumber)!)
  const includedLineRanges: number[][] = []
  for (const n of included) {
    const last = includedLineRanges.at(-1)
    if (last && last[1] === n - 1) last[1] = n
    else includedLineRanges.push([n, n])
  }
  return { excerpt: chunks.join('\n'), complete: false, totalLines: lines.length, includedLineRanges, partialLines }
}

export function actionLocation(repository: string, check: GitHubEvidence): { runId: number; jobId?: number } | undefined {
  if (check.app?.slug && check.app.slug !== 'github-actions') return undefined
  for (const value of [check.html_url, check.details_url]) {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- URL fields are untrusted GitHub evidence and must be checked before parsing.
    if (typeof value !== 'string') continue
    let url: URL
    try { url = new URL(value) } catch { continue }
    if (url.hostname !== 'github.com') continue
    const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?\/?$/)
    if (match && match[1]?.toLowerCase() === repository.toLowerCase()) {
      const location: { runId: number; jobId?: number } = { runId: Number(match[2]) }
      // doctor-disable-next-line typescript/style/no-conditional-empty-object-spread -- Keep optional jobId absent when the URL points at a workflow run.
      if (match[3]) location.jobId = Number(match[3])
      return location
    }
  }
  return undefined
}

/** Fetch failed job evidence before invoking the model. No GraphQL or gh run view. */
export async function hydrateFailedCiEvidence(inbox: PullRequestInbox, claim: Claim, readers: CiEvidenceReaders, now = Date.now()) {
  const { repository } = claim.snapshot, headSha = claim.snapshot.pr?.head?.sha
  const evidence: CiEvidence[] = [], seenJobs = new Set<number>()
  let remaining = 48_000
  for (const check of Object.values(claim.snapshot.checks)) {
    if (!headSha || check.head_sha !== headSha || !failed(check)) continue
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
        // doctor-disable-next-line typescript/style/no-conditional-empty-object-spread -- Retry metadata is omitted after all jobs complete.
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
          cached = { value: { log }, fetchedAt: now }
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
