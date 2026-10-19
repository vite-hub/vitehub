import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCheckWait, wakeReasons } from '../src/babysitter/wait.ts'
import { PullRequestInbox } from '../src/babysitter/inbox/store.ts'

const repository = 'example/project'
const pr = { number: 7, state: 'open', head: { sha: 'a', ref: 'repair' }, base: { ref: 'main' } }
const wait = { reason: 'Required check is pending', evidenceKey: 'required:pending;feedback:none' }
async function setup(t: { onTestFinished: (fn: () => void) => void }) {
  const inbox = new PullRequestInbox({ path: ':memory:', repositories: [repository] })
  t.onTestFinished(() => inbox.close())
  await inbox.seed(repository, pr)
  return inbox
}
async function terminalCheck(inbox: PullRequestInbox, id: string, conclusion = 'success') {
  return await inbox.ingest(id, 'check_run', { repository: { full_name: repository }, action: 'completed',
    check_run: { id: 10, name: 'optional', head_sha: 'a', status: 'completed', conclusion, pull_requests: [{ number: 7 }] } })
}

test('webhook evidence stays durable without model passes until host policy changes', async t => {
  const inbox = await setup(t)
  assert.equal(await inbox.finish((await inbox.claim(1))[0]!, { text: 'waiting', wait }), true)
  assert.deepEqual((await terminalCheck(inbox, 'optional')).queued, [])
  const observed = (await inbox.get(repository, 7))!
  assert.equal(observed.status, 'waiting')
  assert.equal(await inbox.wake(observed, wait.evidenceKey), false)
  assert.equal((await inbox.claim(1)).length, 0)
  assert.deepEqual((await inbox.summary())[0]!.wait, { ...wait, headSha: 'a' })
  // The host maps a required-check completion to changed policy evidence.
  await terminalCheck(inbox, 'required', 'failure')
  assert.equal(await inbox.wake(observed, 'required:failed;feedback:none'), false)
  assert.equal(await inbox.wake((await inbox.get(repository, 7))!, 'required:failed;feedback:none'), true)
  assert.equal((await inbox.claim(1)).length, 1)
})

test('revision changes fence wait creation and wake even without a new generation', async t => {
  const inbox = await setup(t)
  const claim = (await inbox.claim(1))[0]!
  await inbox.ingest('pending', 'check_run', { repository: { full_name: repository }, action: 'created',
    check_run: { id: 10, head_sha: 'a', status: 'queued', pull_requests: [{ number: 7 }] } })
  assert.equal(await inbox.finish(claim, { text: 'stale', wait }), false)
  assert.equal((await inbox.get(repository, 7))!.lease, null)
  assert.equal(await inbox.finish((await inbox.claim(1))[0]!, { text: 'waiting', wait }), true)
  const observed = (await inbox.get(repository, 7))!
  await inbox.ingest('progress', 'check_run', { repository: { full_name: repository }, action: 'in_progress',
    check_run: { id: 10, head_sha: 'a', status: 'in_progress', pull_requests: [{ number: 7 }] } })
  assert.equal(await inbox.wake(observed, 'changed'), false)
})

test('new heads clear waits and closed PRs cannot wake', async t => {
  const inbox = await setup(t)
  await inbox.finish((await inbox.claim(1))[0]!, { text: 'waiting', wait })
  const old = (await inbox.get(repository, 7))!
  await inbox.seed(repository, { ...pr, head: { sha: 'b', ref: 'repair' } })
  assert.equal(await inbox.wake(old, 'changed'), false)
  assert.equal((await inbox.get(repository, 7))!.wait, undefined)
  const claim = (await inbox.claim(1))[0]!
  assert.equal(claim.snapshot.pr?.head?.sha, 'b')
  await inbox.finish(claim, { text: 'waiting', wait })
  await inbox.seed(repository, { ...pr, head: { sha: 'b' }, state: 'closed' })
  assert.equal((await inbox.get(repository, 7))!.wait, undefined)
  assert.equal((await inbox.claim(1)).length, 0)
})

test('explicit waits survive process restart and duplicate deliveries', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'github-inbox-wait-'))
  const path = join(dir, 'inbox.sqlite')
  const first = new PullRequestInbox({ path, repositories: [repository] })
  await first.seed(repository, pr)
  await first.finish((await first.claim(1))[0]!, { text: 'waiting', wait })
  await terminalCheck(first, 'delivery')
  await first.close()
  const second = new PullRequestInbox({ path, repositories: [repository] })
  t.onTestFinished(async () => { await second.close(); rmSync(dir, { recursive: true, force: true }) })
  assert.equal((await terminalCheck(second, 'delivery')).duplicate, true)
  await second.recoverLeases()
  assert.equal((await second.claim(1)).length, 0)
  assert.equal(await second.wake((await second.get(repository, 7))!, 'required:passed;feedback:none'), true)
  assert.equal((await second.claim(1)).length, 1)
})

test('invalid wait requests cannot release a claim or mix retry semantics', async t => {
  const inbox = await setup(t)
  const claim = (await inbox.claim(1))[0]!
  await assert.rejects(async () => inbox.finish(claim, { text: 'bad', wait: { ...wait, reason: '' } }))
  await assert.rejects(async () => inbox.finish(claim, { text: 'bad', wait, retry: true }))
  assert.equal((await inbox.get(repository, 7))!.lease, claim.token)
})

test('persisted waits are validated by both snapshot readers', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'github-inbox-wait-'))
  const path = join(dir, 'inbox.sqlite')
  const inbox = new PullRequestInbox({ path, repositories: [repository] })
  const db = new DatabaseSync(path)
  t.onTestFinished(async () => { db.close(); await inbox.close(); rmSync(dir, { recursive: true, force: true }) })
  await inbox.seed(repository, pr)
  await inbox.finish((await inbox.claim(1))[0]!, { text: 'waiting', wait })
  const snapshot = (await inbox.get(repository, 7))!
  db.prepare('UPDATE vitehub_babysitter_pull_requests SET value=? WHERE repository=? AND number=?')
    .run(JSON.stringify({ ...snapshot, wait: { ...snapshot.wait, reason: '' } }), repository, 7)
  await assert.rejects(async () => inbox.get(repository, 7))
  // Queue-wide reads skip the invalid row instead of failing for every PR.
  assert.deepEqual(await inbox.all(), [])
})

test('host reconciliation wakes new feedback and old owners cannot release replacements', async t => {
  const inbox = await setup(t)
  const oldClaim = (await inbox.claim(1))[0]!
  await inbox.finish(oldClaim, { text: 'waiting', wait })
  await inbox.ingest('feedback', 'issue_comment', { repository: { full_name: repository }, action: 'created',
    issue: { number: 7, pull_request: {} }, comment: { id: 20, body: 'A new repair is needed' } })
  assert.equal((await inbox.claim(1)).length, 0)
  const observed = (await inbox.get(repository, 7))!
  assert.equal(await inbox.wake(observed, `feedback:${observed.comments['20']!.body}`), true)
  const replacement = (await inbox.claim(1))[0]!
  assert.equal(await inbox.finish(oldClaim, { text: 'stale', wait }), false)
  assert.equal((await inbox.get(repository, 7))!.lease, replacement.token)
})

test('a PR closed during work stays terminal when stale wait completion releases its lease', async t => {
  const inbox = await setup(t)
  const claim = (await inbox.claim(1))[0]!
  await inbox.seed(repository, { ...pr, state: 'closed' })
  assert.equal(await inbox.finish(claim, { text: 'stale', wait }), false)
  assert.equal((await inbox.get(repository, 7))!.lease, null)
  assert.equal((await inbox.get(repository, 7))!.status, 'terminal')
  assert.equal((await inbox.claim(1)).length, 0)
})

for (const source of ['seed', 'webhook'] as const) {
  test(`${source} filter transitions clear waits and admit recovered PRs`, async t => {
    const inbox = new PullRequestInbox({ path: ':memory:', repositories: [repository], filter: { labels: { deny: ['hold'] } } })
    t.onTestFinished(() => inbox.close())
    await inbox.seed(repository, pr)
    assert.equal(await inbox.finish((await inbox.claim(1))[0]!, { text: 'waiting', wait }), true)
    const update = async (labels: string[]) => source === 'seed'
      ? await inbox.seed(repository, { ...pr, labels })
      : await inbox.ingest(`labels:${labels.join(',')}`, 'pull_request', {
          repository: { full_name: repository }, action: labels.length ? 'labeled' : 'unlabeled',
          pull_request: { ...pr, labels },
        })
    update(['hold'])
    assert.equal((await inbox.get(repository, 7))!.status, 'terminal')
    assert.equal((await inbox.get(repository, 7))!.wait, undefined)
    assert.equal((await inbox.claim(1)).length, 0)
    update([])
    assert.equal((await inbox.get(repository, 7))!.status, 'ready')
    assert.equal((await inbox.get(repository, 7))!.wait, undefined)
    assert.equal((await inbox.claim(1)).length, 1)
  })
}

for (const event of ['feedback', 'failure', 'progress'] as const) {
  test(`pinned waits retain concurrent ${event} for host evaluation`, async t => {
    const inbox = await setup(t)
    const claim = (await inbox.claim(1))[0]!
    const policy = { workerAuthors: new Set<string>(), pendingReviewChecks: new Set<string>(), wakeWhenReady: false, noFindingsReviews: [] }
    const declared = { ...createCheckWait(claim.snapshot, policy), headSha: pr.head.sha }
    if (event === 'feedback') {
      await inbox.ingest('feedback', 'issue_comment', { repository: { full_name: repository }, action: 'created',
        issue: { number: pr.number, pull_request: {} }, comment: { id: 20, body: 'Please fix this', user: { login: 'reviewer' } } })
    } else {
      await inbox.ingest(event, 'check_run', { repository: { full_name: repository }, action: event === 'failure' ? 'completed' : 'created',
        check_run: { id: 10, name: 'test', app: { slug: 'github-actions' }, head_sha: pr.head.sha,
          status: event === 'failure' ? 'completed' : 'in_progress', conclusion: event === 'failure' ? 'failure' : null,
          pull_requests: [{ number: pr.number }] } })
    }
    assert.equal(await inbox.finish(claim, { text: 'Waiting', wait: declared }), true)
    const current = (await inbox.get(repository, pr.number))!
    assert.deepEqual(current.wait, declared)
    if (event !== 'progress') {
      assert.ok(current.generation > current.handled)
      assert.equal((await inbox.waitsToEvaluate()).length, 1)
      assert.ok(wakeReasons(current, 'pending', policy).includes(event === 'feedback' ? 'feedback-changed' : 'new-failure'))
      assert.equal(await inbox.wake(current, `evaluated:${current.generation}`), true)
      assert.equal((await inbox.claim(1)).length, 1)
    } else {
      assert.deepEqual(wakeReasons(current, 'pending', policy), [])
      assert.equal((await inbox.claim(1)).length, 0)
    }
  })
}

for (const synchronize of [false, true]) {
  test(`pinned publication chains retain terminal evidence, synchronize=${synchronize}`, async t => {
    const inbox = await setup(t)
    const claim = (await inbox.claim(1))[0]!
    const heads = ['b'.repeat(40), 'c'.repeat(40)]
    for (const head of heads) {
      await inbox.ingest(`push:${head}`, 'push', { repository: { full_name: repository }, ref: 'refs/heads/repair', after: head })
      await inbox.ingest(`failure:${head}`, 'status', { repository: { full_name: repository }, sha: head, context: 'test', state: 'failure' })
      if (synchronize) await inbox.ingest(`synchronize:${head}`, 'pull_request', {
        repository: { full_name: repository }, action: 'synchronize', pull_request: { ...pr, head: { ...pr.head, sha: head } },
      })
    }
    const head = heads[1]!
    assert.equal(await inbox.finish(claim, { text: 'Repair pushed', wait: { ...wait, kind: 'checks', headSha: head },
      progress: { kind: 'verified', evidence: `push:${head}` }, verifiedPushHeads: heads }), true)
    const current = (await inbox.get(repository, pr.number))!
    assert.equal(current.wait?.headSha, head)
    assert.equal(current.statuses.test?.state, 'failure')
    assert.equal(current.statuses.test?.sha, head)
    assert.ok(current.generation > current.handled)
    assert.equal((await inbox.waitsToEvaluate()).length, 1)
  })
}
