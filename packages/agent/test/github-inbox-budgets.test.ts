import { test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PullRequestInbox } from '../src/server/github-inbox.ts'

const repository = 'vite-hub/vitehub'
const pr = (head = 'a') => ({ number: 7, state: 'open', head: { sha: head, ref: 'fix' }, base: { ref: 'main' } })
function create(path = ':memory:') { return new PullRequestInbox({ path, repositories: [repository], budgets: { providerRetries: 3, noProgress: 3 }, clock: () => Date.now() + 60 * 60_000 }) }
function memory(t: { onTestFinished: (fn: () => void) => void }) { const inbox = create(); t.onTestFinished(() => inbox.close()); return inbox }
async function wake(inbox: PullRequestInbox, id: number) {
  await inbox.ingest(String(id), 'issue_comment', { repository: { full_name: repository }, issue: { number: 7, pull_request: {} }, comment: { id, body: `feedback ${id}` } })
}

test('persisted progress budgets are validated by both snapshot readers', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'inbox-budgets-'))
  const path = join(directory, 'inbox.sqlite')
  const inbox = create(path)
  const db = new DatabaseSync(path)
  t.onTestFinished(async () => { db.close(); await inbox.close(); rmSync(directory, { recursive: true, force: true }) })
  await inbox.seed(repository, pr())
  const snapshot = (await inbox.get(repository, 7))!
  db.prepare('UPDATE vitehub_babysitter_pull_requests SET value=? WHERE repository=? AND number=?')
    .run(JSON.stringify({ ...snapshot, progressBudget: { head: 'a', limit: -1 } }), repository, 7)
  await assert.rejects(async () => inbox.get(repository, 7))
  await assert.rejects(async () => inbox.all())
})

test('initial provider attempt plus three retries stop across restart and two store handles', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'inbox-budgets-'))
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'inbox.sqlite')
  let inbox = create(path)
  const peer = create(path)
  t.onTestFinished(async () => { await inbox.close(); await peer.close() })
  for (let index = 0; index < 4; index++) {
    const token = await (index % 2 ? peer : inbox).reserveProviderAttempt('account')
    assert.ok(token)
    assert.ok(await inbox.finishProviderAttempt(token, 'retryable-failure'))
    assert.equal(await peer.finishProviderAttempt(token, 'retryable-failure'), false)
  }
  await inbox.close(); inbox = create(path)
  assert.equal(await inbox.reserveProviderAttempt('account'), undefined)
  assert.equal(await peer.reserveProviderAttempt('account'), undefined)
  assert.equal((await inbox.providerBudget('account'))?.failures.length, 4)
  const pending = []
  for (let index = 0; index < 4; index++) pending.push(await inbox.reserveProviderAttempt('different-account'))
  assert.ok(pending.every(Boolean))
  await inbox.close(); inbox = create(path)
  assert.equal(await inbox.reserveProviderAttempt('different-account'), undefined)
  await inbox.resetProviderBudget('account', 'Operator confirmed quota restored')
  assert.ok(await peer.reserveProviderAttempt('account'))
})

test('successful provider calls do not consume retries; unrelated errors do not impose a quota stop', async t => {
  const inbox = memory(t)
  for (let index = 0; index < 10; index++) {
    const token = (await inbox.reserveProviderAttempt('account'))!
    assert.ok(token)
    await inbox.finishProviderAttempt(token, index % 2 ? 'success' : 'other-failure')
  }
  assert.deepEqual((await inbox.providerBudget('account'))?.failures, [])
})

test('pending dispatches bound parallel admission and crash recovery fails closed', async t => {
  const inbox = memory(t)
  const tokens = []
  for (let index = 0; index < 4; index++) tokens.push((await inbox.reserveProviderAttempt('account'))!)
  assert.ok(tokens.every(Boolean))
  assert.equal(await inbox.reserveProviderAttempt('account'), undefined)
  await inbox.finishProviderAttempt(tokens[0]!, 'success')
  assert.ok(await inbox.reserveProviderAttempt('account'))
  await inbox.resetProviderBudget('account', 'Operator inspected interrupted dispatches')
  assert.equal(await inbox.finishProviderAttempt(tokens[1]!, 'retryable-failure'), false)
})

test('out-of-order successes and failures cannot clear newer failures or charge older failures', async t => {
  const inbox = memory(t)
  const first = (await inbox.reserveProviderAttempt('account'))!
  const second = (await inbox.reserveProviderAttempt('account'))!
  await inbox.finishProviderAttempt(second, 'retryable-failure')
  await inbox.finishProviderAttempt(first, 'success')
  assert.deepEqual((await inbox.providerBudget('account'))?.failures, [second.attempt])
  const third = (await inbox.reserveProviderAttempt('account'))!
  const fourth = (await inbox.reserveProviderAttempt('account'))!
  await inbox.finishProviderAttempt(fourth, 'success')
  await inbox.finishProviderAttempt(third, 'retryable-failure')
  assert.deepEqual((await inbox.providerBudget('account'))?.failures, [])
})

test('three explicit no-progress completions stop regardless of result text, retry flag or webhook', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr())
  for (let index = 0; index < 3; index++) {
    await wake(inbox, index)
    const claim = (await inbox.claim(1))[0]!
    assert.ok(claim)
    await inbox.finish(claim, { text: 'I made progress!', progress: { kind: 'no-progress' } })
    assert.equal(await inbox.finish(claim, { text: 'duplicate', progress: { kind: 'no-progress' } }), false)
  }
  await wake(inbox, 4)
  assert.equal((await inbox.claim(1)).length, 0)
  assert.equal((await inbox.summary())[0]?.progressBudget?.count, 3)
  assert.equal(await inbox.resetProgressBudget(repository, 7, 'stale-head', 'Operator retry'), false)
  assert.ok(await inbox.resetProgressBudget(repository, 7, 'a', 'Operator investigated missing permission'))
  assert.equal((await inbox.claim(1)).length, 1)
  assert.equal(await inbox.resetProgressBudget(repository, 7, 'a', 'Cannot reset an active claim'), false)
})

test('exhausted same-head deliveries persist feedback and closure without queueing stale work', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr())
  for (let index = 0; index < 3; index++) {
    await wake(inbox, index)
    await inbox.finish((await inbox.claim(1))[0]!, { text: 'waiting', progress: { kind: 'no-progress' } })
  }
  const feedback = {
    repository: { full_name: repository }, issue: { number: 7, pull_request: {} },
    comment: { id: 9, body: 'New feedback after exhaustion' },
  }
  assert.deepEqual(await inbox.ingest('feedback', 'issue_comment', feedback), { accepted: true, updated: [7], queued: [] })
  assert.equal((await inbox.get(repository, 7))?.comments['9']?.body, feedback.comment.body)
  assert.equal((await inbox.claim(1)).length, 0)
  assert.equal((await inbox.ingest('feedback', 'issue_comment', feedback)).duplicate, true)

  const closed = { repository: { full_name: repository }, action: 'closed', pull_request: { ...pr(), state: 'closed' } }
  assert.deepEqual(await inbox.ingest('closed', 'pull_request', closed), { accepted: true, updated: [7], queued: [] })
  assert.equal((await inbox.get(repository, 7))?.pr?.state, 'closed')
  assert.equal((await inbox.get(repository, 7))?.status, 'terminal')
  assert.equal((await inbox.ingest('closed', 'pull_request', closed)).duplicate, true)
  assert.equal(await inbox.resetProgressBudget(repository, 7, 'a', 'Operator retry'), false)
  assert.equal((await inbox.claim(1)).length, 0)
})

test('new heads get a fresh budget and stale completions cannot charge them', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr())
  const old = (await inbox.claim(1))[0]!
  await inbox.seed(repository, pr('b'))
  await inbox.finish(old, { text: 'old pass', progress: { kind: 'no-progress' } })
  assert.equal((await inbox.get(repository, 7))?.progressBudget, undefined)
  const current = (await inbox.claim(1))[0]!
  assert.equal(current.snapshot.pr?.head?.sha, 'b')
  await inbox.finish(current, { text: 'pass', progress: { kind: 'no-progress' } })
  assert.equal((await inbox.get(repository, 7))?.progressBudget?.count, 1)
})

test('host-verified new evidence resets consecutive no-progress; repeated evidence does not', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr())
  const outcomes = [{ kind: 'no-progress' }, { kind: 'verified', evidence: 'thread:123:resolved' }, { kind: 'verified', evidence: 'thread:123:resolved' }] as const
  for (let index = 0; index < outcomes.length; index++) {
    await wake(inbox, index)
    await inbox.finish((await inbox.claim(1))[0]!, { text: 'finished', progress: outcomes[index] })
  }
  assert.equal((await inbox.get(repository, 7))?.progressBudget?.count, 1)
  await assert.rejects(async () => inbox.resetProviderBudget('account', '  '))
  assert.throws(() => new PullRequestInbox({ path: ':memory:', repositories: [], budgets: { noProgress: 0 } }))
})

test('no-progress exhaustion survives reopen and head replacement is immediately eligible', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'inbox-progress-'))
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'inbox.sqlite')
  let inbox = create(path)
  t.onTestFinished(() => inbox.close())
  await inbox.seed(repository, pr())
  for (let index = 0; index < 3; index++) {
    await wake(inbox, index)
    await inbox.finish((await inbox.claim(1))[0]!, { text: 'waiting', progress: { kind: 'no-progress' } })
  }
  await inbox.close(); inbox = create(path)
  await wake(inbox, 8)
  assert.equal((await inbox.claim(1)).length, 0)
  await inbox.seed(repository, pr('b'))
  assert.equal((await inbox.claim(1))[0]?.snapshot.pr?.head?.sha, 'b')
})

test('nonconsecutive evidence replay cannot reset a head budget across restart or manual reset', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'inbox-evidence-'))
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'inbox.sqlite')
  let inbox = create(path)
  t.onTestFinished(() => inbox.close())
  await inbox.seed(repository, pr())
  for (const [index, evidence] of ['thread:123:resolved', 'thread:456:resolved'].entries()) {
    await wake(inbox, index)
    await inbox.finish((await inbox.claim(1))[0]!, { text: 'resolved', progress: { kind: 'verified', evidence } })
  }
  await inbox.close(); inbox = create(path)
  await wake(inbox, 3)
  await inbox.finish((await inbox.claim(1))[0]!, { text: 'replay', progress: { kind: 'verified', evidence: 'thread:123:resolved' } })
  assert.equal((await inbox.get(repository, 7))?.progressBudget?.count, 1)
  await inbox.resetProgressBudget(repository, 7, 'a', 'Operator requested retry')
  await inbox.finish((await inbox.claim(1))[0]!, { text: 'replay', progress: { kind: 'verified', evidence: 'thread:456:resolved' } })
  const budget = (await inbox.get(repository, 7))?.progressBudget
  assert.equal(budget?.count, 1)
  assert.equal(budget?.resetReason, 'Operator requested retry')
  assert.equal(budget?.evidence, 'thread:456:resolved')
  assert.deepEqual(budget?.creditedEvidence, ['thread:123:resolved', 'thread:456:resolved'])
})

for (const limits of [{ initial: 5, next: 3 }, { initial: 3, next: 5 }]) {
  test(`head limit ${limits.initial} survives reopen with ${limits.next} until reset`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'inbox-limit-'))
    const path = join(directory, 'inbox.sqlite')
    const open = (noProgress: number) => new PullRequestInbox({ path, repositories: [repository], budgets: { noProgress } })
    let inbox = open(limits.initial)
    const peer = open(limits.next)
    t.onTestFinished(async () => { await inbox.close(); await peer.close(); rmSync(directory, { recursive: true, force: true }) })
    await inbox.seed(repository, pr())
    await inbox.finish((await inbox.claim(1))[0]!, { text: 'waiting', progress: { kind: 'no-progress' } })
    await inbox.close(); inbox = open(limits.next)
    for (let index = 1; index < limits.initial; index++) {
      await wake(inbox, index)
      const worker = index % 2 ? peer : inbox
      const claim = (await worker.claim(1))[0]
      assert.ok(claim)
      await worker.finish(claim, { text: 'waiting', progress: { kind: 'no-progress' } })
      assert.equal((await worker.summary())[0]?.progressBudget?.limit, limits.initial)
    }
    await wake(peer, 20)
    assert.equal((await inbox.claim(1)).length, 0)
    assert.equal((await peer.claim(1)).length, 0)
    assert.ok(await inbox.resetProgressBudget(repository, 7, 'a', 'Operator adopted new limit'))
    assert.equal((await peer.summary())[0]?.progressBudget?.limit, limits.next)
    for (let index = 0; index < limits.next; index++) {
      await wake(peer, 30 + index)
      const claim = (await peer.claim(1))[0]
      assert.ok(claim)
      await peer.finish(claim, { text: 'waiting', progress: { kind: 'no-progress' } })
    }
    await wake(inbox, 40)
    assert.equal((await peer.claim(1)).length, 0)
    await inbox.seed(repository, pr('b'))
    await inbox.finish((await inbox.claim(1))[0]!, { text: 'waiting', progress: { kind: 'no-progress' } })
    assert.equal((await peer.summary())[0]?.progressBudget?.limit, limits.next)
  })
}

test('persisted progress limits apply to workers without local budget configuration', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'inbox-mixed-'))
  const path = join(directory, 'inbox.sqlite')
  const inbox = new PullRequestInbox({ path, repositories: ['Vite-Hub/ViteHub'], budgets: { noProgress: 3 } })
  const peer = new PullRequestInbox({ path, repositories: [repository] })
  t.onTestFinished(async () => { await inbox.close(); await peer.close(); rmSync(directory, { recursive: true, force: true }) })
  await inbox.seed(repository, pr())
  await peer.finish((await peer.claim(1))[0]!, { text: 'unconfigured', progress: { kind: 'no-progress' } })
  assert.equal((await peer.summary())[0]?.progressBudget, undefined)
  await wake(inbox, 1)
  await inbox.finish((await inbox.claim(1))[0]!, { text: 'configured', progress: { kind: 'no-progress' } })
  for (let index = 2; index <= 3; index++) {
    await wake(peer, index)
    await peer.finish((await peer.claim(1))[0]!, { text: 'unconfigured', progress: { kind: 'no-progress' } })
  }
  assert.equal((await peer.summary())[0]?.progressBudget?.count, 3)
  await wake(peer, 4)
  assert.equal((await peer.claim(1)).length, 0)
  assert.equal((await inbox.claim(1)).length, 0)
  assert.ok(await inbox.resetProgressBudget('Vite-Hub/ViteHub', 7, 'a', 'Operator retry'))
  assert.equal((await peer.claim(1)).length, 1)
})

test('explicit waits and exhausted budgets must both clear before admission', async t => {
  const inbox = memory(t)
  await inbox.seed(repository, pr())
  const wait = { reason: 'Required checks pending', evidenceKey: 'checks:pending' }
  for (let index = 0; index < 3; index++) {
    const claim = (await inbox.claim(1))[0]!
    assert.ok(claim)
    assert.equal(await inbox.finish(claim, { text: 'No progress', progress: { kind: 'no-progress' }, wait }), true)
    if (index < 2) assert.equal(await inbox.wake((await inbox.get(repository, 7))!, `checks:${index}`), true)
  }
  assert.equal((await inbox.summary())[0]!.progressBudget?.exhausted, true)
  assert.equal((await inbox.summary())[0]!.wait?.evidenceKey, wait.evidenceKey)
  assert.equal(await inbox.wake((await inbox.get(repository, 7))!, 'checks:passed'), true)
  assert.equal((await inbox.claim(1)).length, 0)
  assert.equal(await inbox.resetProgressBudget(repository, 7, 'a', 'Operator verified progress'), true)
  const claim = (await inbox.claim(1))[0]!
  assert.ok(claim)
  await inbox.finish(claim, { text: 'Waiting', progress: { kind: 'no-progress' }, wait })
  assert.equal(await inbox.resetProgressBudget(repository, 7, 'a', 'Operator reset budget'), true)
  assert.equal((await inbox.claim(1)).length, 0)
  assert.equal(await inbox.wake((await inbox.get(repository, 7))!, 'checks:passed'), true)
  assert.equal((await inbox.claim(1)).length, 1)
})

test('stale wait completion releases its claim without charging progress', async t => {
  const inbox = memory(t)
  await inbox.seed(repository, pr())
  const claim = (await inbox.claim(1))[0]!
  await wake(inbox, 500)
  assert.equal(await inbox.finish(claim, { text: 'Stale', progress: { kind: 'no-progress' },
    wait: { reason: 'Checks pending', evidenceKey: 'checks:pending' } }), false)
  assert.equal((await inbox.get(repository, 7))!.progressBudget, undefined)
  assert.equal((await inbox.get(repository, 7))!.wait, undefined)
  assert.equal((await inbox.claim(1)).length, 1)
})
