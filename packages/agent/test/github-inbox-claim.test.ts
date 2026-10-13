import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PullRequestInbox } from '../src/server/github-inbox.ts'
import { snapshotPullRequest, claimStopReason, createClaimStopCheck } from '../src/server/github-inbox.ts'

async function fixture(clock?: () => number) {
  const inbox = new PullRequestInbox({path: ':memory:', repositories: ['vite-hub/vitehub'], clock})
  await inbox.seed('vite-hub/vitehub', { number: 42, state: 'open', user: { login: 'onmax' }, head: { sha: 'new', ref: 'feature', repo: { full_name: 'vite-hub/vitehub' } }, base: { sha: 'base', ref: 'main' }, headRefOid: 'stale', headRefName: 'stale-branch', title: 'Test', html_url: 'https://github.com/vite-hub/vitehub/pull/42', updated_at: '2026-09-13T00:00:00Z' })
  return inbox
}

test('REST webhook head overrides persisted stale GraphQL aliases for checkout', async () => {
  const inbox = await fixture()
  try {
    const claim = (await inbox.claim(1))[0]!
    assert.ok(claim)
    const pr = snapshotPullRequest(claim.snapshot)
    assert.equal(pr.headRefOid, 'new')
    assert.equal(pr.headRefName, 'feature')
    assert.equal(pr.state, 'OPEN')
    assert.equal(pr.url, 'https://github.com/vite-hub/vitehub/pull/42')
  } finally { await inbox.close() }
})

test('same-head feedback leaves active pass running; new head cancels without network polling', async () => {
  const inbox = await fixture()
  try {
    const claim = (await inbox.claim(1))[0]!
    const current = structuredClone(claim.snapshot)
    current.generation++
    assert.equal(claimStopReason(claim, current), undefined)
    current.pr!.head!.sha = 'newer'
    assert.equal(claimStopReason(claim, current), 'Pull request head changed.')
  } finally { await inbox.close() }
})

test('terminal webhook and lost lease cancel active pass', async () => {
  const inbox = await fixture()
  try {
    const claim = (await inbox.claim(1))[0]!
    const current = structuredClone(claim.snapshot)
    current.status = 'terminal'
    assert.equal(claimStopReason(claim, current), 'Pull request is no longer open.')
    current.lease = 'another-owner'
    assert.equal(claimStopReason(claim, current), 'Pull request lease lost.')
  } finally { await inbox.close() }
})

test('new generation remains claimable after old pass parks, without second completion gate', async () => {
  const inbox = await fixture()
  try {
    const old = (await inbox.claim(1))[0]!
    await inbox.ingest('comment', 'issue_comment', { repository: { full_name: 'vite-hub/vitehub' }, issue: { number: 42, pull_request: {} }, action: 'created', comment: { id: 1, body: 'Please fix test', user: { login: 'onmax', type: 'User' } } })
    await inbox.finish(old, { text: 'Waiting for checks' })
    const next = (await inbox.claim(1))[0]!
    assert.ok(next)
    assert.ok(next.generation > old.generation)
    assert.equal(next.snapshot.comments['1']!.body, 'Please fix test')
  } finally { await inbox.close() }
})

test('own repair head proven from provider Git survives cleanup; external head still cancels', async () => {
 const inbox = await fixture()
 try {
  const claim = (await inbox.claim(1))[0]!
  const current = structuredClone(claim.snapshot)
  let reads = 0, cleanup = false
  const check = createClaimStopCheck(claim, async () => current, async () => { reads++; if (cleanup) throw new Error('provider directory removed'); return 'repair' })
  assert.equal(await check(), undefined)
  assert.equal(reads, 0)
  current.pr!.head!.sha = 'repair'
  assert.equal(await check(), undefined)
  assert.equal(reads, 1)
  cleanup = true
  assert.equal(await check(), undefined)
  assert.equal(reads, 1)
  current.pr!.head!.sha = 'external'
  assert.equal(await check(), 'Pull request head changed.')
  assert.equal(reads, 2)
 } finally { await inbox.close() }
})

test('head change without a provider HEAD match cancels regardless of bot identity', async () => {
 const inbox = await fixture()
 try {
  const claim = (await inbox.claim(1))[0]!, current = structuredClone(claim.snapshot)
  current.pr!.head!.sha = 'external'; current.pr!.user = { login: 'vitehub-bot' }
  for (const providerHead of [undefined, 'different']) {
   const check = createClaimStopCheck(claim, async () => current, async () => providerHead)
   assert.equal(await check(), 'Pull request head changed.')
  }
  const failed = createClaimStopCheck(claim, async () => current, async () => { throw new Error('git failed') })
  assert.equal(await failed(), 'Pull request head changed.')
 } finally { await inbox.close() }
})

test('closed PR and lease loss win even after a verified repair push', async () => {
 const inbox = await fixture()
 try {
  const claim = (await inbox.claim(1))[0]!, current = structuredClone(claim.snapshot)
  current.pr!.head!.sha = 'repair'
  const check = createClaimStopCheck(claim, async () => current, async () => 'repair')
  assert.equal(await check(), undefined)
  current.status = 'terminal'
  assert.equal(await check(), 'Pull request is no longer open.')
  current.status = 'working'; current.lease = 'different'
  assert.equal(await check(), 'Pull request lease lost.')
 } finally { await inbox.close() }
})

test('new remote event during provider HEAD read is rechecked before accepting proof', async () => {
 const inbox = await fixture()
 try {
  const claim = (await inbox.claim(1))[0]!, current = structuredClone(claim.snapshot)
  current.pr!.head!.sha = 'repair'
  const check = createClaimStopCheck(claim, async () => current, async () => { current.pr!.head!.sha = 'external'; return 'repair' })
  assert.equal(await check(), 'Pull request head changed.')
 } finally { await inbox.close() }
})

test('expired lease cancels before recovery changes its token', async () => {
  const inbox = await fixture()
  try {
    const claim = (await inbox.claim(1))[0]!
    const current = structuredClone(claim.snapshot)
    current.leaseUntil = Date.now() - 1
    assert.equal(claimStopReason(claim, current), 'Pull request lease lost.')
  } finally { await inbox.close() }
})

test('an expired owner cannot park a published head before lease recovery changes its token', async () => {
  let now = Date.now()
  const inbox = await fixture(() => now)
  try {
    const claim = (await inbox.claim(1))[0]!
    now = claim.snapshot.leaseUntil
    const finished = await inbox.finish(claim, { text: 'Repair pushed.', wait: { kind: 'checks', headSha: 'published', reason: 'Waiting for CI.', evidenceKey: 'push-receipt' } })
    assert.equal(finished, false)
    const current = await inbox.get('vite-hub/vitehub', 42)
    assert.equal(current?.lease, claim.token)
    assert.equal(current?.status, 'working')
    assert.equal(current?.lastResult, undefined)
  } finally { await inbox.close() }
})

test('durable claim fence rejects a released claim before an irreversible action', async () => {
  const inbox = await fixture()
  try {
    const claim = (await inbox.claim(1))[0]!
    assert.equal(await inbox.isClaimCurrent(claim), true)
    await inbox.release(claim)
    assert.equal(await inbox.isClaimCurrent(claim), false)
  } finally { await inbox.close() }
})

test('stack parents are claimed before older independent work', async () => {
  let now = 1_000
  const inbox = new PullRequestInbox({ path: ':memory:', repositories: ['acme/app'], clock: () => now++ })
  try {
    const pr = (number: number, head: string, base: string) => ({ number, state: 'open', head: { sha: `${head}-sha`, ref: head, repo: { full_name: 'acme/app' } }, base: { ref: base, repo: { full_name: 'acme/app' } }, updated_at: '2026-10-01T00:00:00Z' })
    await inbox.seed('acme/app', pr(3, 'independent', 'main'))
    await inbox.seed('acme/app', pr(1, 'parent', 'main'))
    await inbox.seed('acme/app', pr(2, 'child', 'parent'))
    const claims = await inbox.claim(3)
    // The child waits for its parent; the parent goes first although it changed later.
    assert.deepEqual(claims.map(claim => claim.snapshot.number), [1, 3])
  } finally { await inbox.close() }
})

test('startup releases every held lease and keeps recorded waits', async () => {
  const inbox = await fixture()
  try {
    await inbox.seed('vite-hub/vitehub', { number: 43, state: 'open', head: { sha: 'other', ref: 'other' }, base: { ref: 'main' }, updated_at: '2026-09-13T00:00:00Z' })
    const [first, second] = await inbox.claim(2)
    await inbox.finish(second!, { text: 'Waiting', wait: { headSha: 'other', reason: 'checks', evidenceKey: 'key' } })
    const parked = await inbox.claim(1)
    assert.equal(parked.length, 0)
    assert.equal(await inbox.releaseLeases(), 1)
    const released = await inbox.get('vite-hub/vitehub', first!.snapshot.number)
    assert.equal(released?.lease, null)
    assert.equal(released?.status, 'ready')
    assert.equal((await inbox.get('vite-hub/vitehub', second!.snapshot.number))?.status, 'waiting')
    assert.equal(await inbox.releaseLeases(), 0)
    // The released PR is claimable at once instead of after its two-hour lease.
    assert.equal((await inbox.claim(1))[0]?.snapshot.number, first!.snapshot.number)
  } finally { await inbox.close() }
})

test('a verified repair head rejects rollback even if the provider also rolls back', async () => {
 const inbox = await fixture()
 try {
  const claim = (await inbox.claim(1))[0]!, current = structuredClone(claim.snapshot)
  current.pr!.head!.sha = 'repair'
  const check = createClaimStopCheck(claim, async () => current, async () => current.pr!.head!.sha)
  assert.equal(await check(), undefined)
  current.pr!.head!.sha = claim.snapshot.pr!.head!.sha
  assert.equal(await check(), 'Pull request head changed.')
 } finally { await inbox.close() }
})


test('each successive worker repair head is verified while unrelated heads still cancel', async () => {
  const inbox = await fixture()
  try {
    const claim = (await inbox.claim(1))[0]!, current = structuredClone(claim.snapshot)
    let providerHead = 'repair-first', reads = 0
    const check = createClaimStopCheck(claim, async () => current, async () => { reads++; return providerHead })
    current.pr!.head!.sha = providerHead
    assert.equal(await check(), undefined)
    assert.equal(reads, 1)
    providerHead = 'repair-second'; current.pr!.head!.sha = providerHead
    assert.equal(await check(), undefined)
    assert.equal(reads, 2)
    assert.equal(await check(), undefined)
    assert.equal(reads, 2, 'an already proven head survives cleanup without repeated Git reads')
    current.pr!.head!.sha = 'external'
    assert.equal(await check(), 'Pull request head changed.')
    assert.equal(reads, 3)
  } finally { await inbox.close() }
})


test('an original-head source rollback cannot park a verified repair head', async () => {
  const inbox = await fixture()
  try {
    const claim = (await inbox.claim(1))[0]!
    await inbox.ingest('repair-push', 'push', { repository: { full_name: 'vite-hub/vitehub' }, ref: 'refs/heads/feature', after: 'repair' })
    await inbox.ingest('rollback-push', 'push', { repository: { full_name: 'vite-hub/vitehub' }, ref: 'refs/heads/feature', after: 'new' })
    const finished = await inbox.finish(claim, { text: 'Repair pushed.', wait: { kind: 'checks', headSha: 'repair', reason: 'Waiting for CI.', evidenceKey: 'push-receipt' }, progress: { kind: 'verified', evidence: 'push:repair' }, verifiedPushHeads: ['repair'] })
    assert.equal(finished, false)
    assert.equal((await inbox.get('vite-hub/vitehub', 42))?.status, 'ready')
    assert.equal((await inbox.get('vite-hub/vitehub', 42))?.wait, undefined)
  } finally { await inbox.close() }
})


test('prospective publication CI association survives opening a new inbox process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prospective-publication-'))
  const options = { path: join(root, 'inbox.sqlite'), repositories: ['vite-hub/vitehub'] }
  let inbox = new PullRequestInbox(options)
  const head = 'b'.repeat(40)
  try {
    await inbox.seed('vite-hub/vitehub', { number: 42, state: 'open', head: { sha: 'a'.repeat(40), ref: 'feature' }, base: { ref: 'main' } })
    const claim = (await inbox.claim(1))[0]!
    await assert.rejects(inbox.registerProspectivePush(claim, 'unvalidated'), /exact publication/)
    assert.equal(await inbox.registerProspectivePush(claim, head), true)
    await inbox.close()
    inbox = new PullRequestInbox(options)
    assert.equal((await inbox.get('vite-hub/vitehub', 42))?.prospectivePush?.token, claim.token)
    await inbox.ingest('ci-before-source-push', 'status', { repository: { full_name: 'vite-hub/vitehub' }, sha: head, context: 'test', state: 'failure' })
    assert.equal((await inbox.get('vite-hub/vitehub', 42))?.statuses.test?.state, 'failure')
    assert.equal((await inbox.get('vite-hub/vitehub', 42))?.sourcePushHead, undefined, 'candidate association is not a verified publication')
    assert.equal(await inbox.release(claim), true)
    assert.equal((await inbox.get('vite-hub/vitehub', 42))?.prospectivePush, undefined)
  } finally { await inbox.close(); await rm(root, { recursive: true, force: true }) }
})

for (const change of ['lease expired', 'external head', 'claim replaced'] as const) {
  test(`prospective publication association is fenced after ${change}`, async () => {
    let now = Date.now()
    const inbox = await fixture(() => now)
    const head = 'b'.repeat(40)
    try {
      const claim = (await inbox.claim(1))[0]!
      assert.equal(await inbox.registerProspectivePush(claim, head), true)
      if (change === 'lease expired') now = claim.snapshot.leaseUntil + 1
      else if (change === 'external head') await inbox.ingest('external-synchronize', 'pull_request', {
        repository: { full_name: 'vite-hub/vitehub' }, action: 'synchronize',
        pull_request: { ...claim.snapshot.pr!, head: { ...claim.snapshot.pr!.head!, sha: 'c'.repeat(40) } },
      })
      else { await inbox.release(claim); await inbox.claim(1) }
      await inbox.ingest('obsolete-candidate-ci', 'status', { repository: { full_name: 'vite-hub/vitehub' }, sha: head, context: 'obsolete', state: 'failure' })
      assert.equal((await inbox.get('vite-hub/vitehub', 42))?.statuses.obsolete, undefined)
      assert.equal(await inbox.registerProspectivePush(claim, 'd'.repeat(40)), false)
    } finally { await inbox.close() }
  })
}

for (const evidence of ['check', 'status'] as const) {
  test(`late ${evidence} for an abandoned candidate cannot mutate a newer synchronized claim`, async () => {
    const inbox = await fixture()
    const abandoned = 'a'.repeat(40), published = 'b'.repeat(40), pending = 'c'.repeat(40)
    try {
      const claim = (await inbox.claim(1))[0]!
      for (const head of [abandoned, published, pending]) {
        const current = (await inbox.get('vite-hub/vitehub', 42))!
        assert.equal(await inbox.registerProspectivePush({ ...claim, generation: current.generation, snapshot: current }, head), true)
      }
      await inbox.ingest('newer-candidate-synchronized', 'pull_request', {
        repository: { full_name: 'vite-hub/vitehub' }, action: 'synchronize',
        pull_request: { ...claim.snapshot.pr!, head: { ...claim.snapshot.pr!.head!, sha: published } },
      })
      const before = (await inbox.get('vite-hub/vitehub', 42))!
      await inbox.ingest('abandoned-candidate-ci', evidence === 'check' ? 'check_run' : 'status', {
        repository: { full_name: 'vite-hub/vitehub' },
        ...(evidence === 'check' ? { check_run: { id: 99, name: 'abandoned', head_sha: abandoned, status: 'completed', conclusion: 'failure', pull_requests: [{ number: 42 }] } }
          : { sha: abandoned, context: 'abandoned', state: 'failure' }),
      })
      const after = (await inbox.get('vite-hub/vitehub', 42))!
      assert.equal(after.checks['check_run:99'], undefined)
      assert.equal(after.statuses.abandoned, undefined)
      assert.equal(after.generation, before.generation)
      assert.equal(after.revision, before.revision)
      await inbox.ingest('still-pending-candidate-ci', 'status', {
        repository: { full_name: 'vite-hub/vitehub' }, sha: pending, context: 'future', state: 'failure',
      })
      assert.equal((await inbox.get('vite-hub/vitehub', 42))?.statuses.future?.state, 'failure', 'a candidate registered after the synchronized head is still pending')
    } finally { await inbox.close() }
  })
}

test('source push overflow fences only the current claim without fabricating a head', async () => {
  const inbox = await fixture()
  const heads = Array.from({ length: 65 }, (_, index) => (index + 1).toString(16).padStart(40, '0'))
  try {
    const claim = (await inbox.claim(1))[0]!
    for (const head of heads) await inbox.ingest(`source-push-${head}`, 'push', {
      repository: { full_name: 'vite-hub/vitehub' }, ref: 'refs/heads/feature', after: head,
    })
    const overflow = (await inbox.get('vite-hub/vitehub', 42))!
    assert.deepEqual(overflow.sourcePushHeads, heads.slice(0, 64), 'retained publication evidence contains only observed heads')
    const head = heads.at(-1)!
    assert.equal(await inbox.finish(claim, { text: 'Repair pushed.',
      wait: { kind: 'checks', headSha: head, reason: 'Waiting for CI.', evidenceKey: 'push-receipt' },
      progress: { kind: 'verified', evidence: `push:${head}` }, verifiedPushHeads: heads,
    }), false, 'overflowed publication custody requires a fresh claim')
    const next = (await inbox.claim(1))[0]!
    assert.ok(next)
    assert.deepEqual(next.snapshot.sourcePushHeads, [])
    assert.equal(await inbox.registerProspectivePush(next, 'f'.repeat(40)), true, 'a new claim can publish normally')
  } finally { await inbox.close() }
})
