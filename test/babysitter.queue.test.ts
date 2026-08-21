import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type PullRequest,
  pullRequestFingerprint,
  resolveRepositories,
  runPullRequestJobs,
  selectPullRequestJobs,
} from '../server/babysitter.queue.ts'

function pullRequest(number: number): PullRequest {
  return {
    body: '',
    headRefName: `branch-${number}`,
    headRefOid: `head-${number}`,
    headRepository: { nameWithOwner: 'example/repo' },
    isDraft: true,
    mergeStateStatus: 'CLEAN',
    number,
    reviewDecision: null,
    state: 'OPEN',
    statusCheckRollup: [],
    title: `PR ${number}`,
    updatedAt: '2026-07-17T00:00:00Z',
    url: `https://github.com/example/repo/pull/${number}`,
  }
}

test('uses the singular repository when the plural setting is empty', () => {
  assert.deepEqual(resolveRepositories('', 'vite-hub/vitehub'), ['vite-hub/vitehub'])
  assert.deepEqual(resolveRepositories('Vite-Hub/Brief, vite-hub/brief vite-hub/nuxt-agent', 'vite-hub/vitehub'), [
    'vite-hub/brief',
    'vite-hub/nuxt-agent',
  ])
})

test('enumerates repositories into one queue', async () => {
  const listed: string[] = []
  const jobs = await selectPullRequestJobs(
    ['vite-hub/vitehub', 'vite-hub/brief'],
    async repository => {
      listed.push(repository)
      return repository === 'vite-hub/vitehub' ? [pullRequest(1)] : [pullRequest(2), pullRequest(3)]
    },
    async () => null,
  )

  assert.deepEqual(listed.sort(), ['vite-hub/brief', 'vite-hub/vitehub'])
  assert.deepEqual(jobs.map(job => [job.repository, job.pullRequest.number]), [
    ['vite-hub/vitehub', 1],
    ['vite-hub/brief', 2],
    ['vite-hub/brief', 3],
  ])
})

test('interleaves repositories before their deeper backlog', async () => {
  const jobs = await selectPullRequestJobs(
    ['vite-hub/vitehub', 'vite-hub/brief'],
    async repository => repository === 'vite-hub/vitehub'
      ? [pullRequest(1), pullRequest(2), pullRequest(3)]
      : [pullRequest(4)],
    async () => null,
  )
  assert.deepEqual(jobs.map(job => [job.repository, job.pullRequest.number]), [
    ['vite-hub/vitehub', 1],
    ['vite-hub/brief', 4],
    ['vite-hub/vitehub', 2],
    ['vite-hub/vitehub', 3],
  ])
})

test('keeps completion state qualified by repository', async () => {
  const completed = pullRequest(1)
  const jobs = await selectPullRequestJobs(
    ['vite-hub/vitehub', 'vite-hub/brief'],
    async () => [completed],
    async key => key === 'babysitter/vite-hub/vitehub/pull-requests/1' ? pullRequestFingerprint('vite-hub/vitehub', completed) : null,
  )

  assert.notEqual(pullRequestFingerprint('vite-hub/vitehub', completed), pullRequestFingerprint('vite-hub/brief', completed))
  assert.deepEqual(jobs.map(job => job.repository), ['vite-hub/brief'])
  assert.equal(jobs[0]?.completionKey, 'babysitter/vite-hub/brief/pull-requests/1')
})

test('keeps healthy repositories when one listing fails', async (t) => {
  t.mock.method(console, 'error', () => {})
  const jobs = await selectPullRequestJobs(
    ['vite-hub/missing', 'vite-hub/brief'],
    async repository => {
      if (repository === 'vite-hub/missing') throw new Error('Not found')
      return [pullRequest(1)]
    },
    async () => null,
  )
  assert.deepEqual(jobs.map(job => job.repository), ['vite-hub/brief'])
})

test('keeps the backlog available beyond the active owner count', async () => {
  const jobs = await selectPullRequestJobs(
    ['vite-hub/vitehub'],
    async () => [pullRequest(1), pullRequest(2), pullRequest(3)],
    async () => null,
  )

  assert.deepEqual(jobs.map(job => job.pullRequest.number), [1, 2, 3])
})

test('starts the next pull request when an owner becomes free', async () => {
  const started: number[] = []
  let releaseFirst!: () => void
  let confirmThird!: () => void
  const first = new Promise<void>(resolve => releaseFirst = resolve)
  const third = new Promise<void>(resolve => confirmThird = resolve)
  const jobs = [1, 2, 3].map(number => ({
    completionKey: String(number),
    fingerprint: String(number),
    pullRequest: pullRequest(number),
    repository: 'vite-hub/vitehub',
  }))

  const running = runPullRequestJobs(jobs, 2, async job => {
    started.push(job.pullRequest.number)
    if (job.pullRequest.number === 1) await first
    if (job.pullRequest.number === 3) confirmThird()
  })
  await Promise.race([
    third,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Owner slot was not refilled.')), 100)),
  ])
  assert.deepEqual(started, [1, 2, 3])
  releaseFirst()
  await running
})
