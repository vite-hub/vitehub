import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PullRequestInbox } from '../src/server/github-inbox.ts'

const repository = 'vite-hub/vitehub'
const pr = (head = 'a') => ({ number: 7, state: 'open', head: { sha: head, ref: 'fix' }, base: { ref: 'main' } })
function create(path = ':memory:') { return new PullRequestInbox({ path, repositories: [repository], budgets: { providerRetries: 3, noProgress: 3 }, clock: () => Date.now() + 60 * 60_000 }) }
function memory(t: { onTestFinished: (fn: () => void) => void }) { const inbox = create(); t.onTestFinished(() => inbox.close()); return inbox }
function wake(inbox: PullRequestInbox, id: number) {
  inbox.ingest(String(id), 'issue_comment', { repository: { full_name: repository }, issue: { number: 7, pull_request: {} }, comment: { id, body: `feedback ${id}` } })
}

test('initial provider attempt plus three retries stop across restart and two store handles', t => {
  const directory = mkdtempSync(join(tmpdir(), 'inbox-budgets-'))
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'inbox.sqlite')
  let inbox = create(path)
  const peer = create(path)
  t.onTestFinished(() => { inbox.close(); peer.close() })
  for (let index = 0; index < 4; index++) {
    const token = (index % 2 ? peer : inbox).reserveProviderAttempt('account')
    assert.ok(token)
    assert.ok(inbox.finishProviderAttempt(token, 'retryable-failure'))
    assert.equal(peer.finishProviderAttempt(token, 'retryable-failure'), false)
  }
  inbox.close(); inbox = create(path)
  assert.equal(inbox.reserveProviderAttempt('account'), undefined)
  assert.equal(peer.reserveProviderAttempt('account'), undefined)
  assert.equal(inbox.providerBudget('account')?.failures.length, 4)
  const pending = Array.from({ length: 4 }, () => inbox.reserveProviderAttempt('different-account'))
  assert.ok(pending.every(Boolean))
  inbox.close(); inbox = create(path)
  assert.equal(inbox.reserveProviderAttempt('different-account'), undefined)
  inbox.resetProviderBudget('account', 'Operator confirmed quota restored')
  assert.ok(peer.reserveProviderAttempt('account'))
})

test('successful provider calls do not consume retries; unrelated errors do not impose a quota stop', t => {
  const inbox = memory(t)
  for (let index = 0; index < 10; index++) {
    const token = inbox.reserveProviderAttempt('account')!
    assert.ok(token)
    inbox.finishProviderAttempt(token, index % 2 ? 'success' : 'other-failure')
  }
  assert.deepEqual(inbox.providerBudget('account')?.failures, [])
})

test('pending dispatches bound parallel admission and crash recovery fails closed', t => {
  const inbox = memory(t)
  const tokens = Array.from({ length: 4 }, () => inbox.reserveProviderAttempt('account')!)
  assert.ok(tokens.every(Boolean))
  assert.equal(inbox.reserveProviderAttempt('account'), undefined)
  inbox.finishProviderAttempt(tokens[0]!, 'success')
  assert.ok(inbox.reserveProviderAttempt('account'))
  inbox.resetProviderBudget('account', 'Operator inspected interrupted dispatches')
  assert.equal(inbox.finishProviderAttempt(tokens[1]!, 'retryable-failure'), false)
})

test('out-of-order successes and failures cannot clear newer failures or charge older failures', t => {
  const inbox = memory(t)
  const first = inbox.reserveProviderAttempt('account')!
  const second = inbox.reserveProviderAttempt('account')!
  inbox.finishProviderAttempt(second, 'retryable-failure')
  inbox.finishProviderAttempt(first, 'success')
  assert.deepEqual(inbox.providerBudget('account')?.failures, [second.attempt])
  const third = inbox.reserveProviderAttempt('account')!
  const fourth = inbox.reserveProviderAttempt('account')!
  inbox.finishProviderAttempt(fourth, 'success')
  inbox.finishProviderAttempt(third, 'retryable-failure')
  assert.deepEqual(inbox.providerBudget('account')?.failures, [])
})

test('three explicit no-progress completions stop regardless of result text, retry flag or webhook', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  for (let index = 0; index < 3; index++) {
    wake(inbox, index)
    const claim = inbox.claim(1)[0]!
    assert.ok(claim)
    inbox.finish(claim, { text: 'I made progress!', progress: { kind: 'no-progress' } })
    assert.equal(inbox.finish(claim, { text: 'duplicate', progress: { kind: 'no-progress' } }), false)
  }
  wake(inbox, 4)
  assert.equal(inbox.claim(1).length, 0)
  assert.equal(inbox.summary()[0]?.progressBudget?.count, 3)
  assert.equal(inbox.resetProgressBudget(repository, 7, 'stale-head', 'Operator retry'), false)
  assert.ok(inbox.resetProgressBudget(repository, 7, 'a', 'Operator investigated missing permission'))
  assert.equal(inbox.claim(1).length, 1)
  assert.equal(inbox.resetProgressBudget(repository, 7, 'a', 'Cannot reset an active claim'), false)
})

test('new heads get a fresh budget and stale completions cannot charge them', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  const old = inbox.claim(1)[0]!
  inbox.seed(repository, pr('b'))
  inbox.finish(old, { text: 'old pass', progress: { kind: 'no-progress' } })
  assert.equal(inbox.get(repository, 7)?.progressBudget, undefined)
  const current = inbox.claim(1)[0]!
  assert.equal(current.snapshot.pr?.head?.sha, 'b')
  inbox.finish(current, { text: 'pass', progress: { kind: 'no-progress' } })
  assert.equal(inbox.get(repository, 7)?.progressBudget?.count, 1)
})

test('host-verified new evidence resets consecutive no-progress; repeated evidence does not', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  const outcomes = [{ kind: 'no-progress' }, { kind: 'verified', evidence: 'thread:123:resolved' }, { kind: 'verified', evidence: 'thread:123:resolved' }] as const
  for (let index = 0; index < outcomes.length; index++) {
    wake(inbox, index)
    inbox.finish(inbox.claim(1)[0]!, { text: 'finished', progress: outcomes[index] })
  }
  assert.equal(inbox.get(repository, 7)?.progressBudget?.count, 1)
  assert.throws(() => inbox.resetProviderBudget('account', '  '))
  assert.throws(() => new PullRequestInbox({ path: ':memory:', repositories: [], budgets: { noProgress: 0 } }))
})

test('no-progress exhaustion survives reopen and head replacement is immediately eligible', t => {
  const directory = mkdtempSync(join(tmpdir(), 'inbox-progress-'))
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'inbox.sqlite')
  let inbox = create(path)
  t.onTestFinished(() => inbox.close())
  inbox.seed(repository, pr())
  for (let index = 0; index < 3; index++) {
    wake(inbox, index)
    inbox.finish(inbox.claim(1)[0]!, { text: 'waiting', progress: { kind: 'no-progress' } })
  }
  inbox.close(); inbox = create(path)
  wake(inbox, 8)
  assert.equal(inbox.claim(1).length, 0)
  inbox.seed(repository, pr('b'))
  assert.equal(inbox.claim(1)[0]?.snapshot.pr?.head?.sha, 'b')
})

test('nonconsecutive evidence replay cannot reset a head budget across restart or manual reset', t => {
  const directory = mkdtempSync(join(tmpdir(), 'inbox-evidence-'))
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'inbox.sqlite')
  let inbox = create(path)
  t.onTestFinished(() => inbox.close())
  inbox.seed(repository, pr())
  for (const [index, evidence] of ['thread:123:resolved', 'thread:456:resolved'].entries()) {
    wake(inbox, index)
    inbox.finish(inbox.claim(1)[0]!, { text: 'resolved', progress: { kind: 'verified', evidence } })
  }
  inbox.close(); inbox = create(path)
  wake(inbox, 3)
  inbox.finish(inbox.claim(1)[0]!, { text: 'replay', progress: { kind: 'verified', evidence: 'thread:123:resolved' } })
  assert.equal(inbox.get(repository, 7)?.progressBudget?.count, 1)
  inbox.resetProgressBudget(repository, 7, 'a', 'Operator requested retry')
  inbox.finish(inbox.claim(1)[0]!, { text: 'replay', progress: { kind: 'verified', evidence: 'thread:456:resolved' } })
  const budget = inbox.get(repository, 7)?.progressBudget
  assert.equal(budget?.count, 1)
  assert.equal(budget?.resetReason, 'Operator requested retry')
  assert.equal(budget?.evidence, 'thread:456:resolved')
  assert.deepEqual(budget?.creditedEvidence, ['thread:123:resolved', 'thread:456:resolved'])
})
