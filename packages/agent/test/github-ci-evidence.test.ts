import { it, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import { PullRequestInbox, type GitHubEvidence } from '../src/server/github-inbox.ts'
import { diagnosticExcerpt, hydrateFailedCiEvidence } from '../src/server/github-inbox/ci-evidence.ts'
import { rerunFailedActions } from '../src/presets/babysitter/ci-recovery.ts'
import type { Claim } from '../src/server/github-inbox.ts'
const repository = 'vite-hub/vitehub'
const pr = { number: 7, state: 'open', user: { login: 'onmax' }, head: { sha: 'head', ref: 'fix' }, base: { ref: 'main' } }
const check = (patch: GitHubEvidence = {}) => ({ id: 11, name: 'types', app: { slug: 'github-actions' }, head_sha: 'head', status: 'completed', conclusion: 'failure', completed_at: '2026-09-13T10:00:00Z', html_url: `https://github.com/${repository}/actions/runs/1/job/11`, ...patch })
const job = (patch: GitHubEvidence = {}) => ({ id: 11, run_id: 1, run_attempt: 1, name: 'types', head_sha: 'head', status: 'completed', conclusion: 'failure', completed_at: '2026-09-13T10:00:00Z', steps: [{ number: 2, name: 'Typecheck', conclusion: 'failure' }], ...patch })
const inboxes: PullRequestInbox[] = []
afterEach(async () => { await Promise.all(inboxes.splice(0).map(inbox => inbox.close())) })
async function fixture(checks: GitHubEvidence[] = [check()]) {
 const inbox = new PullRequestInbox({path: ':memory:', repositories: [repository]}); inboxes.push(inbox); await inbox.seed(repository, pr)
 const claim = (await inbox.claim(1))[0]!; await inbox.hydrate(claim, { checks: Object.fromEntries(checks.map(c => [`check_run:${c.id}`, c])) })
 return { inbox, claim }
}
it('failed current-head job metadata and log are fetched once, cached and attached before model launch', async () => {
 const { inbox, claim } = await fixture(); let jsonCalls = 0, logCalls = 0
 const readers = { readJson: async (path: string) => { jsonCalls++; assert.equal(path, `repos/${repository}/actions/jobs/11`); return [job()] }, readLog: async () => { logCalls++; return '##[error] Type mismatch\nsource.ts:2' } }
 assert.equal(await hydrateFailedCiEvidence(inbox, claim, readers), true)
 assert.equal(await hydrateFailedCiEvidence(inbox, claim, readers), true)
 assert.equal(jsonCalls, 1); assert.equal(logCalls, 1)
 const evidence = claim.snapshot.ciEvidence![0]!
 assert.equal(evidence.status, 'available'); assert.equal(evidence.complete, true)
 assert.equal(evidence.excerpt, '##[error] Type mismatch\nsource.ts:2'); assert.equal((evidence.failedSteps as {name:string}[])[0]!.name, 'Typecheck')
 assert.equal(((await inbox.meta(String(evidence.cacheKey))) as { value: { log: string } }).value.log, evidence.excerpt)
})
it('pending, skipped, success and old-head checks never fetch job metadata or logs', async () => {
 const { inbox, claim } = await fixture([check({ id: 1, status: 'queued', conclusion: null }), check({ id: 2, conclusion: 'success' }), check({ id: 3, conclusion: 'skipped' }), check({ id: 4, head_sha: 'old' })])
 await hydrateFailedCiEvidence(inbox, claim, { readJson: async () => assert.fail('no metadata request'), readLog: async () => assert.fail('no log request') })
 assert.deepEqual(claim.snapshot.ciEvidence, [])
})
it('failed run mapping downloads only completed failed current-head jobs and deduplicates direct job', async () => {
 const { inbox, claim } = await fixture([check({ id: 100, app: undefined, html_url: `https://github.com/${repository}/actions/runs/1` }), check()]); let logs = 0, json = 0
 await hydrateFailedCiEvidence(inbox, claim, { readJson: async path => { json++; assert.ok(path.includes('/runs/1/jobs?')); return [job(), job({ id: 12, conclusion: 'success' }), job({ id: 13, status: 'in_progress' }), job({ id: 14, head_sha: 'old' })] }, readLog: async () => { logs++; return 'failed' } })
 assert.equal(logs, 1); assert.equal(json, 1); assert.equal(claim.snapshot.ciEvidence?.length, 1)
})
it('unavailable logs are distinct from CI failures and retried only after two minutes', async () => {
 const { inbox, claim } = await fixture(); let logCalls = 0
 const readers = { readJson: async () => [job()], readLog: async () => { logCalls++; throw new Error('API unavailable with arbitrary sensitive response') } }
 await hydrateFailedCiEvidence(inbox, claim, readers, 1000)
 await hydrateFailedCiEvidence(inbox, claim, readers, 120_999)
 assert.equal(logCalls, 1)
 assert.equal(claim.snapshot.ciEvidence![0]!.status, 'unavailable')
 assert.equal(JSON.stringify(claim.snapshot.ciEvidence).includes('sensitive'), false)
 await hydrateFailedCiEvidence(inbox, claim, readers, 121_000); assert.equal(logCalls, 2)
})
it('external reviewer check and unrelated job head never download an action log', async () => {
 const { inbox, claim } = await fixture([check({ id: 8, app: { slug: 'pullfrog' } }), check()])
 await hydrateFailedCiEvidence(inbox, claim, { readJson: async () => [job({ head_sha: 'default-branch' })], readLog: async () => assert.fail('unrelated log') })
 assert.equal(claim.snapshot.ciEvidence![0]!.status, 'unsupported')
 assert.equal(claim.snapshot.ciEvidence![1]!.status, 'unavailable')
})
it('webhook received during log fetch invalidates stale evidence but preserves reusable cached log', async () => {
 const { inbox, claim } = await fixture()
 const result = await hydrateFailedCiEvidence(inbox, claim, { readJson: async () => [job()], readLog: async () => {
  await inbox.ingest('pending', 'status', { repository: { full_name: repository }, sha: 'head', context: 'other', state: 'pending' })
  return '##[error] proof'
 } })
 assert.equal(result, false); assert.equal((await inbox.get(repository, 7))?.ciEvidence, undefined)
 assert.equal((await inbox.get(repository, 7))?.statuses.other?.state, 'pending')
})
it('diagnostic excerpts disclose every omitted or partial line and respect budgets', () => {
 const lines = Array.from({ length: 2000 }, (_, n) => n === 1000 ? '##[error] important diagnostic' : `log line ${n} ${'x'.repeat(60)}`)
 const result = diagnosticExcerpt(lines.join('\n'), 1600)
 assert.equal(result.complete, false); assert.equal(result.totalLines, 2000)
 assert.ok(result.excerpt.includes('important diagnostic')); assert.ok(result.excerpt.length <= 1600)
 assert.deepEqual(result.includedLineRanges, [[997, 1006]])
 const partial = diagnosticExcerpt('##[error] '+ 'x'.repeat(50_000), 100)
 assert.equal(partial.excerpt.length, 100); assert.deepEqual(partial.partialLines, [1])
 assert.equal(diagnosticExcerpt('large log', 0).excerpt, '')
})
it('diagnostic excerpts retain a failure tail after a noisy log prefix', () => {
 const noise = Array.from({ length: 3000 }, (_, n) => `runner output ${n} ${'x'.repeat(60)}`)
 const result = diagnosticExcerpt([...noise, 'AssertionError: expected 2 to be 3', 'Error: Process completed with exit code 1.'].join('\n'), 1600)
 assert.ok(result.excerpt.length <= 1600)
 assert.match(result.excerpt, /AssertionError: expected 2 to be 3/)
 assert.match(result.excerpt, /exit code 1\.$/)
 assert.ok(result.includedLineRanges.at(-1)![0] > 2900)
})
it('whole snapshot excerpt budget caps at 48k while complete logs remain cached', async () => {
 const checks = [11,12,13,14].map(id => check({ id, html_url: `https://github.com/${repository}/actions/runs/1/job/${id}` }))
 const { inbox, claim } = await fixture(checks)
 await hydrateFailedCiEvidence(inbox, claim, { readJson: async path => [job({ id: Number(path.split('/').at(-1)) })], readLog: async () => '##[error] '+ 'x'.repeat(20_000) })
 assert.equal(claim.snapshot.ciEvidence!.reduce((total, e) => total + String(e.excerpt).length, 0), 48_000)
 assert.equal(claim.snapshot.ciEvidence![3]!.complete, false); assert.equal(claim.snapshot.ciEvidence![3]!.fullLogCached, true)
})

it('new immutable job attempt refreshes its log while previous successful fetch remains cached', async () => {
 const { inbox, claim } = await fixture(); let calls = 0; let attempt = 1
 const readers = { readJson: async () => [job({ run_attempt: attempt, completed_at: `attempt-${attempt}` })], readLog: async () => { calls++; return `attempt ${attempt} log` } }
 await hydrateFailedCiEvidence(inbox, claim, readers, 1000)
 const firstKey = claim.snapshot.ciEvidence![0]!.cacheKey
 attempt = 2
 await inbox.hydrate(claim, { checks: { changed: check({ run_attempt: 2, completed_at: 'attempt-2' }) } })
 await hydrateFailedCiEvidence(inbox, claim, readers, 2000)
 assert.equal(calls, 2)
 assert.notEqual(claim.snapshot.ciEvidence![0]!.cacheKey, firstKey)
 assert.equal(((await inbox.meta(String(firstKey))) as { value: { log: string } }).value.log, 'attempt 1 log')
 await hydrateFailedCiEvidence(inbox, claim, readers, 3000)
 assert.equal(calls, 2); assert.equal(claim.snapshot.ciEvidence![0]!.fetchedAt, new Date(2000).toISOString())
})

it.each(['cancelled', 'stale'])('hydrates %s checks and jobs', async conclusion => {
 const { inbox, claim } = await fixture([check({ conclusion })])
 await hydrateFailedCiEvidence(inbox, claim, { readJson: async () => [job({ conclusion })], readLog: async () => 'Runner stopped' })
 assert.equal(claim.snapshot.ciEvidence![0]!.status, 'available')
})
it('prunes expired CI logs and metadata while retaining recent logs and unrelated metadata', async () => {
 const { inbox, claim } = await fixture()
 await hydrateFailedCiEvidence(inbox, claim, { readJson: async () => [job()], readLog: async () => 'old log' }, 1)
 const expiredKey = String(claim.snapshot.ciEvidence![0]!.cacheKey)
 await inbox.setMeta('ci-evidence:v1:job-log:recent', { fetchedAt: Date.now(), value: { log: 'recent' } })
 await inbox.setMeta('ci-evidence:v1:jobs:legacy', { value: { jobs: [] } })
 await inbox.setMeta('review-assessment:keep', { head: 'head' })
 await inbox.pruneDeliveries()
 assert.equal(await inbox.meta(expiredKey), undefined)
 assert.equal(await inbox.meta('ci-evidence:v1:jobs:legacy'), undefined)
 assert.equal((await inbox.metaEntries('ci-evidence:v1:')).length, 1)
 assert.deepEqual(await inbox.meta('review-assessment:keep'), { head: 'head' })
})

it('keeps the diagnostic anchor before oversized trailing context', () => {
 const result = diagnosticExcerpt('Error: actual failure\n' + 'x'.repeat(20000), 100)
 assert.match(result.excerpt, /Error: actual failure/)
 assert.ok(result.excerpt.length <= 100)
 assert.deepEqual(result.partialLines, [2])
})

const workflowRun = (patch = {}) => ({ head_sha: 'head', run_attempt: 1, status: 'completed', conclusion: 'failure', run_started_at: '2026-09-13T09:00:00Z', ...patch })

it('waits for a completed rerun and fresh failed evidence without check run_attempt', async () => {
 const metadata = new Map<string, unknown>(); const commands: string[][] = []
 const { claim } = await fixture()
 const inbox = { meta: async (key: string) => metadata.get(key), setMeta: async (key: string, value: unknown) => { metadata.set(key, value) } }
 let workflow = workflowRun()
 const command = async (args: string[]) => { commands.push(args); return { stdout: args.includes('POST') ? '' : JSON.stringify(workflow), stderr: '' } }
 assert.equal((await rerunFailedActions(inbox, claim, command))?.state, 'rerun')
 assert.equal((await rerunFailedActions(inbox, claim, command))?.state, 'waiting')
 workflow = workflowRun({ run_attempt: 2, status: 'in_progress', conclusion: null, run_started_at: '2026-09-13T11:00:00Z' })
 assert.equal((await rerunFailedActions(inbox, claim, command))?.state, 'waiting')
 workflow = { ...workflow, status: 'completed', conclusion: 'success' }
 assert.equal((await rerunFailedActions(inbox, claim, command))?.state, 'waiting')
 workflow = { ...workflow, conclusion: 'failure' }
 assert.equal((await rerunFailedActions(inbox, claim, command))?.state, 'waiting')
 claim.snapshot.checks = { fresh: check({ id: 12, completed_at: '2026-09-13T12:00:00Z' }) }
 assert.equal(await rerunFailedActions(inbox, claim, command), undefined)
 assert.equal(commands.filter(args => args.includes('POST')).length, 1)
})

it('keeps independent reruns waiting and visits later runs beyond the batch limit', async () => {
 const metadata = new Map<string, unknown>(); const posts: string[] = []
 const { claim } = await fixture([1, 2, 3, 4].map(id => check({ id, html_url: `https://github.com/${repository}/actions/runs/${id}/job/${id}` })))
 const inbox = { meta: async (key: string) => metadata.get(key), setMeta: async (key: string, value: unknown) => { metadata.set(key, value) } }
 let completed = false
 const command = async (args: string[]) => {
   if (args.includes('POST')) { posts.push(args[3]!); return { stdout: '', stderr: '' } }
   const first = args[1]!.endsWith('/1')
   return { stdout: JSON.stringify(workflowRun(completed && first ? { run_attempt: 2 } : {})), stderr: '' }
 }
 assert.equal((await rerunFailedActions(inbox, claim, command))?.state, 'rerun')
 assert.equal(posts.length, 3)
 completed = true
 assert.equal((await rerunFailedActions(inbox, claim, command))?.state, 'rerun')
 assert.equal(posts.length, 4)
 assert.equal((await rerunFailedActions(inbox, claim, command))?.state, 'waiting')
 assert.equal(posts.length, 4)
})

it('keeps successful rerun metadata when workflow reconciliation fails', async () => {
 const { claim } = await fixture()
 const metadata = new Map<string, unknown>(); const inbox = { meta: async (key: string) => metadata.get(key), setMeta: async (key: string, value: unknown) => { metadata.set(key, value) } }
 await rerunFailedActions(inbox, claim, async () => ({ stdout: JSON.stringify(workflowRun()), stderr: '' }))
 const saved = [...metadata.values()]
 assert.equal((await rerunFailedActions(inbox, claim, async () => { throw new Error('HTTP 500') }))?.state, 'blocked')
 assert.deepEqual([...metadata.values()], saved)
})

it('turns Actions rerun permission failures into a durable external blocker', async () => {
 const metadata = new Map<string, unknown>()
 const claim = { snapshot: { repository, pr: { head: { sha: 'head' } }, checks: {
   first: check({ html_url: `https://github.com/${repository}/actions/runs/42/job/11` }),
 } } } as unknown as Claim
 const inbox = { meta: async (key: string) => metadata.get(key), setMeta: async (key: string, value: unknown) => { metadata.set(key, value) } }
 const result = await rerunFailedActions(inbox, claim, async () => { throw new Error('HTTP 403: Resource not accessible by integration') }, 1_000)
 assert.equal(result?.state, 'blocked'); assert.match((result as { reason: string }).reason, /Actions run 42/)
 assert.equal((([...metadata.values()][0] as { status: string }).status), 'blocked')
})

it('uses a full rerun for canceled workflows', async () => {
 const { inbox, claim } = await fixture([check({ conclusion: 'cancelled' })])
 const posts: string[][] = []
 await rerunFailedActions(inbox, claim, async args => {
  if (args.includes('POST')) posts.push(args)
  return { stdout: JSON.stringify(workflowRun({ conclusion: 'cancelled' })), stderr: '' }
 })
 assert.equal(posts[0]?.[3], `repos/${repository}/actions/runs/1/rerun`)
})

it('keeps the pre-request fence when the success write fails and reconciles after restart', async () => {
 const { inbox, claim } = await fixture()
 let posts = 0
 let workflow = workflowRun()
 const command = async (args: string[]) => {
  if (args.includes('POST')) {
   posts++
   assert.equal((await inbox.meta(`ci-rerun:v1:${repository}:head:1`) as { status: string }).status, 'pending')
  }
  return { stdout: JSON.stringify(workflow), stderr: '' }
 }
 const failingStore = { meta: inbox.meta.bind(inbox), setMeta: async (key: string, value: unknown) => {
  if ((value as { status: string }).status === 'succeeded') throw new Error('write interrupted')
  await inbox.setMeta(key, value)
 } }
 assert.equal((await rerunFailedActions(failingStore, claim, command, 1000))?.state, 'blocked')
 assert.equal((await rerunFailedActions(inbox, claim, command, 2000))?.state, 'waiting')
 workflow = workflowRun({ run_attempt: 2 })
 assert.equal(await rerunFailedActions(inbox, claim, command, 3000), undefined)
 assert.equal(posts, 1)
})

it('releases an ambiguous interrupted request to repair without retrying the POST', async () => {
 const { inbox, claim } = await fixture()
 await inbox.setMeta(`ci-rerun:v1:${repository}:head:1`, { status: 'pending', runAttempt: 1, attemptedAt: 1000 })
 assert.equal(await rerunFailedActions(inbox, claim, async args => {
  assert.ok(!args.includes('POST'))
  return { stdout: JSON.stringify(workflowRun()), stderr: '' }
 }, 121000), undefined)
})

it('retries a definite rerun rejection after its provider retry window', async () => {
 const { inbox, claim } = await fixture()
 let posts = 0
 const command = async (args: string[]) => {
  if (args.includes('POST')) { posts++; throw new Error('gh: Unprocessable Entity (HTTP 422)') }
  return { stdout: JSON.stringify(workflowRun()), stderr: '' }
 }
 assert.equal((await rerunFailedActions(inbox, claim, command, 1000))?.state, 'blocked')
 assert.equal((await inbox.meta(`ci-rerun:v1:${repository}:head:1`) as { status: string }).status, 'failed')
 assert.equal((await rerunFailedActions(inbox, claim, command, 2000))?.state, 'blocked')
 assert.equal(posts, 1)
 assert.equal((await rerunFailedActions(inbox, claim, command, 121001))?.state, 'blocked')
 assert.equal(posts, 2)
})

it('retains the rerun fence after an ambiguous HTTP 500 response', async () => {
 const { inbox, claim } = await fixture()
 let posts = 0
 let workflow = workflowRun()
 const command = async (args: string[]) => {
  if (args.includes('POST')) { posts++; throw new Error('gh: Service unavailable (HTTP 500)') }
  return { stdout: JSON.stringify(workflow), stderr: '' }
 }
 assert.equal((await rerunFailedActions(inbox, claim, command, 1000))?.state, 'blocked')
 assert.equal((await inbox.meta(`ci-rerun:v1:${repository}:head:1`) as { status: string }).status, 'pending')
 workflow = workflowRun({ run_attempt: 2 })
 assert.equal(await rerunFailedActions(inbox, claim, command, 121001), undefined)
 assert.equal(await rerunFailedActions(inbox, claim, command, 241001), undefined)
 assert.equal(posts, 1)
})
