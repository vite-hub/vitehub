import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  completedPassFingerprint,
  completionPolicyVersion,
  createPolicyFingerprint,
  defaultMaxOwners,
  parseRequiredChecks,
  type PullRequest,
  pullRequestFingerprint,
  resolveRepositories,
  runPullRequestJobs,
  selectPullRequestJobs,
  successfulPassFingerprint,
} from '../server/babysitter.queue.ts'

const policyFingerprint = createPolicyFingerprint('test policy')

test('starts with one owner on an unmeasured host', () => {
  assert.equal(defaultMaxOwners, '1')
})

test('parses required check output and the no-required-check response', () => {
  assert.deepEqual(parseRequiredChecks('[{"bucket":"pending","name":"ci","state":"PENDING"}]', ''), [
    { bucket: 'pending', name: 'ci', state: 'PENDING' },
  ])
  assert.deepEqual(parseRequiredChecks('', "no required checks reported on the 'feat/ui-package' branch\n"), [])
  assert.deepEqual(parseRequiredChecks('', "no checks reported on the 'feat/ui-package' branch\n"), [])
  assert.equal(parseRequiredChecks('', 'GraphQL request failed'), undefined)
  assert.equal(parseRequiredChecks('', "authentication failed\nno checks reported on the 'main' branch"), undefined)
  assert.equal(parseRequiredChecks('', 'no checks reported'), undefined)
  assert.equal(parseRequiredChecks('', "no required checks reported on the 'main' branch\nnetwork failed"), undefined)
})

function pullRequest(number: number): PullRequest {
  return {
    baseRefName: 'main',
    body: '',
    comments: [],
    headRefName: `branch-${number}`,
    headRefOid: `head-${number}`,
    headRepository: { nameWithOwner: 'example/repo' },
    isDraft: true,
    mergeStateStatus: 'CLEAN',
    number,
    reviewDecision: null,
    reviews: [],
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
    policyFingerprint,
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
    policyFingerprint,
  )
  assert.deepEqual(jobs.map(job => [job.repository, job.pullRequest.number]), [
    ['vite-hub/vitehub', 1],
    ['vite-hub/brief', 4],
    ['vite-hub/vitehub', 2],
    ['vite-hub/vitehub', 3],
  ])
})

test('defers a stacked child while its parent remains open', async () => {
  const parent = {
    ...pullRequest(1011),
    headRefName: 'feat/ui-package',
    mergeStateStatus: 'DIRTY',
  }
  const child = {
    ...pullRequest(1015),
    baseRefName: parent.headRefName,
    mergeStateStatus: 'DIRTY',
  }
  const jobs = await selectPullRequestJobs(
    ['vite-hub/vitehub'],
    async () => [child, parent],
    async () => null,
    policyFingerprint,
  )

  assert.deepEqual(jobs.map(job => job.pullRequest.number), [parent.number])
})

test('admits independent pull requests beside a stacked parent', async () => {
  const parent = { ...pullRequest(1011), headRefName: 'feat/ui-package' }
  const child = { ...pullRequest(1015), baseRefName: parent.headRefName }
  const independent = pullRequest(1022)
  const jobs = await selectPullRequestJobs(
    ['vite-hub/vitehub'],
    async () => [child, parent, independent],
    async () => null,
    policyFingerprint,
  )

  assert.deepEqual(jobs.map(job => job.pullRequest.number), [parent.number, independent.number])
})

test('admits a stacked child after its parent leaves the open snapshot', async () => {
  const child = { ...pullRequest(1015), baseRefName: 'feat/ui-package' }
  const jobs = await selectPullRequestJobs(
    ['vite-hub/vitehub'],
    async () => [child],
    async () => null,
    policyFingerprint,
  )

  assert.deepEqual(jobs.map(job => job.pullRequest.number), [child.number])
})

test('keeps completion state qualified by repository', async () => {
  const completed = pullRequest(1)
  const jobs = await selectPullRequestJobs(
    ['vite-hub/vitehub', 'vite-hub/brief'],
    async () => [completed],
    async key => key === 'babysitter/vite-hub/vitehub/pull-requests/1' ? pullRequestFingerprint('vite-hub/vitehub', completed, policyFingerprint) : null,
    policyFingerprint,
  )

  assert.notEqual(pullRequestFingerprint('vite-hub/vitehub', completed, policyFingerprint), pullRequestFingerprint('vite-hub/brief', completed, policyFingerprint))
  assert.deepEqual(jobs.map(job => job.repository), ['vite-hub/brief'])
  assert.equal(jobs[0]?.completionKey, 'babysitter/vite-hub/brief/pull-requests/1')
})

test('parks every successful open pass until its observed state changes', () => {
  const current = pullRequest(1)
  const completion = successfulPassFingerprint('vite-hub/vitehub', current, policyFingerprint)

  assert.equal(typeof completion, 'string')
  assert.notEqual(completion, pullRequestFingerprint('vite-hub/vitehub', current, policyFingerprint))
  assert.equal(successfulPassFingerprint('vite-hub/vitehub', { ...current, state: 'MERGED' }, policyFingerprint), undefined)
})

test('completes only an explicitly parkable pass', () => {
  const current = pullRequest(1)

  assert.equal(
    completedPassFingerprint(
      'vite-hub/vitehub',
      current,
      policyFingerprint,
      '<!-- babysitter:disposition:park -->\nWaiting for exact-head checks.',
    ),
    successfulPassFingerprint('vite-hub/vitehub', current, policyFingerprint),
  )
  assert.equal(
    completedPassFingerprint(
      'vite-hub/vitehub',
      current,
      policyFingerprint,
      '<!-- babysitter:disposition:retry -->\nRequired CI still fails.',
    ),
    undefined,
  )
  assert.equal(
    completedPassFingerprint(
      'vite-hub/vitehub',
      current,
      policyFingerprint,
      { text: '<!-- babysitter:disposition:park -->\nWaiting for exact-head review.' },
    ),
    successfulPassFingerprint('vite-hub/vitehub', current, policyFingerprint),
  )
  assert.equal(completedPassFingerprint('vite-hub/vitehub', current, policyFingerprint, 'Unchanged.'), undefined)
  assert.equal(
    completedPassFingerprint(
      'vite-hub/vitehub',
      { ...current, state: 'MERGED' },
      policyFingerprint,
      '<!-- babysitter:disposition:park -->',
    ),
    undefined,
  )
})

test('accepts existing full-snapshot completion fingerprints', async () => {
  const current = pullRequest(1)
  const existing = pullRequestFingerprint('vite-hub/vitehub', current, policyFingerprint)

  assert.notEqual(successfulPassFingerprint('vite-hub/vitehub', current, policyFingerprint), existing)
  assert.deepEqual(await selectPullRequestJobs(
    ['vite-hub/vitehub'],
    async () => [current],
    async () => existing,
    policyFingerprint,
  ), [])
})

test('accepts previous timestamp-bearing coarse completion fingerprints', async () => {
  const current = pullRequest(1)
  const previous = pullRequestFingerprint('vite-hub/vitehub', { ...current, statusCheckRollup: 'pending' }, policyFingerprint)

  assert.notEqual(successfulPassFingerprint('vite-hub/vitehub', current, policyFingerprint), previous)
  assert.deepEqual(await selectPullRequestJobs(
    ['vite-hub/vitehub'],
    async () => [current],
    async () => previous,
    policyFingerprint,
  ), [])
})

test('parks unchanged actionable states after one completed repair pass', () => {
  const current = pullRequest(1)

  assert.equal(typeof successfulPassFingerprint('vite-hub/vitehub', { ...current, mergeStateStatus: 'DIRTY' }, policyFingerprint), 'string')
  assert.equal(typeof successfulPassFingerprint('vite-hub/vitehub', { ...current, mergeStateStatus: 'BEHIND' }, policyFingerprint), 'string')
  assert.equal(typeof successfulPassFingerprint('vite-hub/vitehub', {
    ...current,
    requiredStatusCheckRollup: [],
    statusCheckRollup: [{ __typename: 'CheckRun', conclusion: 'FAILURE', status: 'COMPLETED' }],
  }, policyFingerprint), 'string')
  assert.equal(typeof successfulPassFingerprint('vite-hub/vitehub', {
    ...current,
    statusCheckRollup: [{ __typename: 'StatusContext', state: 'ERROR' }],
  }, policyFingerprint), 'string')
})

test('does not rerun unchanged actionable states every schedule', async () => {
  const current = pullRequest(1)
  const actionable = [
    { ...current, mergeStateStatus: 'DIRTY' },
    {
      ...current,
      statusCheckRollup: [{ __typename: 'CheckRun', conclusion: 'FAILURE', status: 'COMPLETED' }],
    },
  ]

  for (const pullRequest of actionable) {
    const completion = successfulPassFingerprint('vite-hub/vitehub', pullRequest, policyFingerprint)!
    const jobs = await selectPullRequestJobs(
      ['vite-hub/vitehub'],
      async () => [pullRequest],
      async () => completion,
      policyFingerprint,
    )
    assert.equal(jobs.length, 0)
  }
})

test('parks clean, pending, and unknown unchanged pull requests', async () => {
  const current = pullRequest(1)
  const pending = { ...current, statusCheckRollup: [{ __typename: 'CheckRun', conclusion: '', status: 'IN_PROGRESS' }] }
  const unknown = { ...current, mergeStateStatus: 'UNKNOWN' }

  for (const pullRequest of [current, pending, unknown]) {
    const completion = successfulPassFingerprint('vite-hub/vitehub', pullRequest, policyFingerprint)!
    assert.equal(successfulPassFingerprint('vite-hub/vitehub', pullRequest, policyFingerprint), completion)
    assert.deepEqual(await selectPullRequestJobs(
      ['vite-hub/vitehub'],
      async () => [pullRequest],
      async () => completion,
      policyFingerprint,
    ), [])
  }
})

test('keeps a completed pending pass parked through check and updatedAt churn', async () => {
  const pending = {
    ...pullRequest(995),
    mergeStateStatus: 'UNSTABLE',
    statusCheckRollup: [
      { __typename: 'CheckRun', conclusion: '', name: 'ci', status: 'IN_PROGRESS' },
      { __typename: 'CheckRun', conclusion: '', name: 'consumer', status: 'IN_PROGRESS' },
    ],
  }
  const later = {
    ...pending,
    statusCheckRollup: [
      { __typename: 'CheckRun', conclusion: '', name: 'ci', status: 'IN_PROGRESS' },
      { __typename: 'CheckRun', conclusion: 'SUCCESS', name: 'consumer', status: 'COMPLETED' },
    ],
    updatedAt: '2026-08-24T01:07:57Z',
  }
  const completion = successfulPassFingerprint('vite-hub/vitehub', pending, policyFingerprint)!

  assert.notEqual(
    pullRequestFingerprint('vite-hub/vitehub', later, policyFingerprint),
    pullRequestFingerprint('vite-hub/vitehub', pending, policyFingerprint),
  )
  assert.equal(successfulPassFingerprint('vite-hub/vitehub', later, policyFingerprint), completion)
  assert.deepEqual(await selectPullRequestJobs(
    ['vite-hub/vitehub'],
    async () => [later],
    async () => completion,
    policyFingerprint,
  ), [])
})

test('parks optional check churn when no required checks exist', async () => {
  const pending = {
    ...pullRequest(1011),
    requiredStatusCheckRollup: [],
    statusCheckRollup: [{ __typename: 'CheckRun', conclusion: '', detailsUrl: 'https://dash.cloudflare.com/example/build', name: 'Workers Builds: vitehub-docs', status: 'IN_PROGRESS', workflowName: '' }],
  }
  const later = {
    ...pending,
    statusCheckRollup: [{ __typename: 'CheckRun', conclusion: 'SUCCESS', detailsUrl: 'https://dash.cloudflare.com/example/build', name: 'Workers Builds: vitehub-docs', status: 'COMPLETED', workflowName: '' }],
    updatedAt: '2026-08-24T01:07:57Z',
  }
  const completion = successfulPassFingerprint('vite-hub/vitehub', pending, policyFingerprint)!

  assert.equal(successfulPassFingerprint('vite-hub/vitehub', later, policyFingerprint), completion)
  assert.deepEqual(await selectPullRequestJobs(
    ['vite-hub/vitehub'],
    async () => [later],
    async () => completion,
    policyFingerprint,
  ), [])
})

test('wakes when repository checks finish while an optional external check remains pending', async () => {
  const externalCheck = {
    __typename: 'CheckRun',
    conclusion: '',
    detailsUrl: 'https://dash.cloudflare.com/example/build',
    name: 'Workers Builds: vitehub-docs',
    status: 'IN_PROGRESS',
    workflowName: '',
  }
  const pending = {
    ...pullRequest(1024),
    mergeStateStatus: 'UNSTABLE',
    requiredStatusCheckRollup: [],
    statusCheckRollup: [
      { __typename: 'CheckRun', conclusion: '', detailsUrl: 'https://github.com/vite-hub/vitehub/actions/runs/1', name: 'ci', status: 'IN_PROGRESS', workflowName: 'ci' },
      externalCheck,
    ],
  }
  const ready = {
    ...pending,
    statusCheckRollup: [
      { __typename: 'CheckRun', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/vite-hub/vitehub/actions/runs/1', name: 'ci', status: 'COMPLETED', workflowName: 'ci' },
      externalCheck,
    ],
  }
  const completion = successfulPassFingerprint('vite-hub/vitehub', pending, policyFingerprint)!

  assert.equal((await selectPullRequestJobs(
    ['vite-hub/vitehub'],
    async () => [ready],
    async () => completion,
    policyFingerprint,
  )).length, 1)
})

test('wakes once when an optional pending check becomes failed, then parks the unchanged failure', async () => {
  const pending = {
    ...pullRequest(1011),
    requiredStatusCheckRollup: [],
    statusCheckRollup: [{ conclusion: '', name: 'Workers Builds: vitehub-docs', status: 'IN_PROGRESS' }],
  }
  const failed = {
    ...pending,
    statusCheckRollup: [{ conclusion: 'FAILURE', name: 'Workers Builds: vitehub-docs', status: 'COMPLETED' }],
  }
  const pendingCompletion = successfulPassFingerprint('vite-hub/vitehub', pending, policyFingerprint)!
  const failedCompletion = successfulPassFingerprint('vite-hub/vitehub', failed, policyFingerprint)!

  assert.notEqual(failedCompletion, pendingCompletion)
  assert.equal((await selectPullRequestJobs(['vite-hub/vitehub'], async () => [failed], async () => pendingCompletion, policyFingerprint)).length, 1)
  assert.deepEqual(await selectPullRequestJobs(['vite-hub/vitehub'], async () => [failed], async () => failedCompletion, policyFingerprint), [])
})

test('does not park a same-head CI failure that arrives while an owner is running', async () => {
  const pending = {
    ...pullRequest(995),
    mergeStateStatus: 'UNSTABLE',
    statusCheckRollup: [{ conclusion: '', name: 'ci', status: 'IN_PROGRESS' }],
  }
  const failed = {
    ...pending,
    statusCheckRollup: [{ conclusion: 'FAILURE', name: 'ci', status: 'COMPLETED' }],
  }
  const completion = successfulPassFingerprint('vite-hub/vitehub', failed, policyFingerprint, pending)!

  assert.equal((await selectPullRequestJobs(
    ['vite-hub/vitehub'],
    async () => [failed],
    async () => completion,
    policyFingerprint,
  )).length, 1)
})

test('parks the new head when an owner pushes a commit', () => {
  const observed = {
    ...pullRequest(995),
    statusCheckRollup: [{ conclusion: 'FAILURE', name: 'ci', status: 'COMPLETED' }],
  }
  const pushed = {
    ...observed,
    headRefOid: 'new-head',
    statusCheckRollup: [{ conclusion: '', name: 'ci', status: 'IN_PROGRESS' }],
  }

  assert.equal(
    successfulPassFingerprint('vite-hub/vitehub', pushed, policyFingerprint, observed),
    successfulPassFingerprint('vite-hub/vitehub', pushed, policyFingerprint),
  )
})

test('uses total feedback identity across gh list and view pagination', async () => {
  const allReviews = Array.from({ length: 113 }, (_, index) => ({ id: `review-${index + 1}` }))
  const viewed = {
    ...pullRequest(995),
    feedback: { comments: { count: 60, latestId: 'comment-60' }, reviews: { count: 113, latestId: 'review-113' } },
    reviews: allReviews,
  }
  const listed = { ...viewed, reviews: allReviews.slice(0, 100) }
  const completion = successfulPassFingerprint('vite-hub/vitehub', viewed, policyFingerprint)!

  assert.equal(successfulPassFingerprint('vite-hub/vitehub', listed, policyFingerprint), completion)
  assert.deepEqual(await selectPullRequestJobs(['vite-hub/vitehub'], async () => [listed], async () => completion, policyFingerprint), [])
  assert.notEqual(successfulPassFingerprint('vite-hub/vitehub', {
    ...listed,
    feedback: { ...listed.feedback, reviews: { count: 114, latestId: 'review-114' } },
  }, policyFingerprint), completion)
})

test('wakes when a required check passes while an optional check remains pending', async () => {
  const pending = {
    ...pullRequest(1011),
    requiredStatusCheckRollup: [{ bucket: 'pending', name: 'ci', state: 'PENDING' }],
    statusCheckRollup: [
      { __typename: 'CheckRun', conclusion: '', name: 'ci', status: 'IN_PROGRESS' },
      { __typename: 'CheckRun', conclusion: '', name: 'Workers Builds: vitehub-docs', status: 'IN_PROGRESS' },
    ],
  }
  const later = {
    ...pending,
    requiredStatusCheckRollup: [{ bucket: 'pass', name: 'ci', state: 'SUCCESS' }],
    statusCheckRollup: [
      { __typename: 'CheckRun', conclusion: 'SUCCESS', name: 'ci', status: 'COMPLETED' },
      { __typename: 'CheckRun', conclusion: '', name: 'Workers Builds: vitehub-docs', status: 'IN_PROGRESS' },
    ],
  }
  const completion = successfulPassFingerprint('vite-hub/vitehub', pending, policyFingerprint)!

  assert.equal((await selectPullRequestJobs(
    ['vite-hub/vitehub'],
    async () => [later],
    async () => completion,
    policyFingerprint,
  )).length, 1)
})

test('wakes a pending pass for success, failure, and review feedback', async () => {
  const pending = {
    ...pullRequest(995),
    mergeStateStatus: 'UNSTABLE',
    statusCheckRollup: [{ __typename: 'CheckRun', conclusion: '', name: 'ci', status: 'IN_PROGRESS' }],
  }
  const completion = successfulPassFingerprint('vite-hub/vitehub', pending, policyFingerprint)!
  const actionable = [
    {
      ...pending,
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ __typename: 'CheckRun', conclusion: 'SUCCESS', name: 'ci', status: 'COMPLETED' }],
    },
    {
      ...pending,
      statusCheckRollup: [{ __typename: 'CheckRun', conclusion: 'FAILURE', name: 'ci', status: 'COMPLETED' }],
    },
    { ...pending, comments: [{ author: { login: 'review-bot' }, body: 'Fix this finding.' }] },
  ]

  for (const pullRequest of actionable) {
    assert.equal((await selectPullRequestJobs(
      ['vite-hub/vitehub'],
      async () => [pullRequest],
      async () => completion,
      policyFingerprint,
    )).length, 1)
  }
})

test('replays a successful pass only when the babysitter policy changes', async () => {
  const current = pullRequest(1)
  const prompt = await readFile(new URL('../server/agents/babysitter/prompt.template.md', import.meta.url), 'utf8')
  const previousPrompt = prompt.replace(
    'Do not block the parent for that stack restriction alone.',
    'Block the parent when GitHub refuses the retarget.',
  )
  const previousPolicy = createPolicyFingerprint(previousPrompt, 'blocker template')
  const currentPolicy = createPolicyFingerprint(prompt, 'blocker template')
  const completion = successfulPassFingerprint('vite-hub/vitehub', current, previousPolicy)!
  const select = (policy: string) => selectPullRequestJobs(
    ['vite-hub/vitehub'],
    async () => [current],
    async () => completion,
    policy,
  )

  assert.deepEqual(await select(previousPolicy), [])
  assert.notEqual(previousPrompt, prompt)
  assert.equal((await select(currentPolicy)).length, 1)
  assert.notEqual(
    successfulPassFingerprint('vite-hub/vitehub', current, currentPolicy),
    completion,
  )
})

test('includes a deterministic completion policy revision in the deployed fingerprint', async () => {
  const current = pullRequest(1)
  const previousPolicy = createPolicyFingerprint('prompt', 'blocker', 'all-visible-checks-v1')
  const currentPolicy = createPolicyFingerprint('prompt', 'blocker', completionPolicyVersion)
  const completion = successfulPassFingerprint('vite-hub/vitehub', current, previousPolicy)!
  const schedule = await readFile(new URL('../server/babysitter.schedule.ts', import.meta.url), 'utf8')

  assert.notEqual(currentPolicy, previousPolicy)
  assert.match(schedule, /createPolicyFingerprint\(promptTemplate, blocker, completionPolicyVersion\)/)
  assert.equal((await selectPullRequestJobs(
    ['vite-hub/vitehub'],
    async () => [current],
    async () => completion,
    currentPolicy,
  )).length, 1)
})

test('ignores updatedAt churn but wakes a parked pass for comments and reviews', () => {
  const current = pullRequest(1)
  const later = { ...current, updatedAt: '2026-08-24T01:07:14Z' }
  const fingerprint = successfulPassFingerprint('vite-hub/vitehub', current, policyFingerprint)

  assert.notEqual(pullRequestFingerprint('vite-hub/vitehub', later, policyFingerprint), pullRequestFingerprint('vite-hub/vitehub', current, policyFingerprint))
  assert.equal(successfulPassFingerprint('vite-hub/vitehub', later, policyFingerprint), fingerprint)
  assert.notEqual(successfulPassFingerprint('vite-hub/vitehub', { ...later, comments: [{ id: 'comment-1' }] }, policyFingerprint), fingerprint)
  assert.notEqual(successfulPassFingerprint('vite-hub/vitehub', { ...later, reviews: [{ id: 'review-1' }] }, policyFingerprint), fingerprint)
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
    policyFingerprint,
  )
  assert.deepEqual(jobs.map(job => job.repository), ['vite-hub/brief'])
})

test('recovers pull requests left with stale working labels', async () => {
  const reserved = { ...pullRequest(1), labels: [{ name: 'Agent: Working' }] }
  const available = { ...pullRequest(2), labels: [{ name: 'Agent: Queued' }] }
  const jobs = await selectPullRequestJobs(
    ['vite-hub/vitehub'],
    async () => [reserved, available],
    async () => null,
    policyFingerprint,
  )

  assert.deepEqual(jobs.map(job => job.pullRequest.number), [1, 2])
})

test('excludes transient lifecycle labels from completion fingerprints', () => {
  const current = pullRequest(1)
  const clean = successfulPassFingerprint('vite-hub/vitehub', current, policyFingerprint)
  const working = successfulPassFingerprint('vite-hub/vitehub', {
    ...current,
    labels: [{ name: 'product' }, { name: 'Agent: Working' }],
  }, policyFingerprint)
  const queued = successfulPassFingerprint('vite-hub/vitehub', {
    ...current,
    labels: [{ name: 'product' }, { name: 'Agent: Queued' }],
  }, policyFingerprint)
  const product = successfulPassFingerprint('vite-hub/vitehub', {
    ...current,
    labels: [{ name: 'product' }],
  }, policyFingerprint)

  assert.equal(working, product)
  assert.equal(queued, product)
  assert.notEqual(clean, product)
})

test('keeps the backlog available beyond the active owner count', async () => {
  const jobs = await selectPullRequestJobs(
    ['vite-hub/vitehub'],
    async () => [pullRequest(1), pullRequest(2), pullRequest(3)],
    async () => null,
    policyFingerprint,
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
