import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PullRequestInbox } from '../src/server/github-inbox.ts'

const repository = 'example/project'
const pr = { number: 7, state: 'open', head: { sha: 'a', ref: 'repair' }, base: { ref: 'main' } }
const wait = { reason: 'Required check is pending', evidenceKey: 'required:pending;feedback:none' }
function setup(t: { onTestFinished: (fn: () => void) => void }) {
  const inbox = new PullRequestInbox({ path: ':memory:', repositories: [repository] })
  t.onTestFinished(() => inbox.close())
  inbox.seed(repository, pr)
  return inbox
}
function terminalCheck(inbox: PullRequestInbox, id: string, conclusion = 'success') {
  return inbox.ingest(id, 'check_run', { repository: { full_name: repository }, action: 'completed',
    check_run: { id: 10, name: 'optional', head_sha: 'a', status: 'completed', conclusion, pull_requests: [{ number: 7 }] } })
}

test('webhook evidence stays durable without model passes until host policy changes', t => {
  const inbox = setup(t)
  assert.equal(inbox.finish(inbox.claim(1)[0]!, { text: 'waiting', wait }), true)
  assert.deepEqual(terminalCheck(inbox, 'optional').queued, [])
  const observed = inbox.get(repository, 7)!
  assert.equal(observed.status, 'waiting')
  assert.equal(inbox.wake(observed, wait.evidenceKey), false)
  assert.equal(inbox.claim(1).length, 0)
  assert.deepEqual(inbox.summary()[0]!.wait, { ...wait, headSha: 'a' })
  // The host maps a required-check completion to changed policy evidence.
  terminalCheck(inbox, 'required', 'failure')
  assert.equal(inbox.wake(observed, 'required:failed;feedback:none'), false)
  assert.equal(inbox.wake(inbox.get(repository, 7)!, 'required:failed;feedback:none'), true)
  assert.equal(inbox.claim(1).length, 1)
})

test('revision changes fence wait creation and wake even without a new generation', t => {
  const inbox = setup(t)
  const claim = inbox.claim(1)[0]!
  inbox.ingest('pending', 'check_run', { repository: { full_name: repository }, action: 'created',
    check_run: { id: 10, head_sha: 'a', status: 'queued', pull_requests: [{ number: 7 }] } })
  assert.equal(inbox.finish(claim, { text: 'stale', wait }), false)
  assert.equal(inbox.get(repository, 7)!.lease, null)
  assert.equal(inbox.finish(inbox.claim(1)[0]!, { text: 'waiting', wait }), true)
  const observed = inbox.get(repository, 7)!
  inbox.ingest('progress', 'check_run', { repository: { full_name: repository }, action: 'in_progress',
    check_run: { id: 10, head_sha: 'a', status: 'in_progress', pull_requests: [{ number: 7 }] } })
  assert.equal(inbox.wake(observed, 'changed'), false)
})

test('new heads clear waits and closed PRs cannot wake', t => {
  const inbox = setup(t)
  inbox.finish(inbox.claim(1)[0]!, { text: 'waiting', wait })
  const old = inbox.get(repository, 7)!
  inbox.seed(repository, { ...pr, head: { sha: 'b', ref: 'repair' } })
  assert.equal(inbox.wake(old, 'changed'), false)
  assert.equal(inbox.get(repository, 7)!.wait, undefined)
  const claim = inbox.claim(1)[0]!
  assert.equal(claim.snapshot.pr?.head?.sha, 'b')
  inbox.finish(claim, { text: 'waiting', wait })
  inbox.seed(repository, { ...pr, head: { sha: 'b' }, state: 'closed' })
  assert.equal(inbox.get(repository, 7)!.wait, undefined)
  assert.equal(inbox.claim(1).length, 0)
})

test('explicit waits survive process restart and duplicate deliveries', t => {
  const dir = mkdtempSync(join(tmpdir(), 'github-inbox-wait-'))
  const path = join(dir, 'inbox.sqlite')
  const first = new PullRequestInbox({ path, repositories: [repository] })
  first.seed(repository, pr)
  first.finish(first.claim(1)[0]!, { text: 'waiting', wait })
  terminalCheck(first, 'delivery')
  first.close()
  const second = new PullRequestInbox({ path, repositories: [repository] })
  t.onTestFinished(() => { second.close(); rmSync(dir, { recursive: true, force: true }) })
  assert.equal(terminalCheck(second, 'delivery').duplicate, true)
  second.recoverLeases()
  assert.equal(second.claim(1).length, 0)
  assert.equal(second.wake(second.get(repository, 7)!, 'required:passed;feedback:none'), true)
  assert.equal(second.claim(1).length, 1)
})

test('invalid wait requests cannot release a claim or mix retry semantics', t => {
  const inbox = setup(t)
  const claim = inbox.claim(1)[0]!
  assert.throws(() => inbox.finish(claim, { text: 'bad', wait: { ...wait, reason: '' } }))
  assert.throws(() => inbox.finish(claim, { text: 'bad', wait, retry: true }))
  assert.equal(inbox.get(repository, 7)!.lease, claim.token)
})

test('host reconciliation wakes new feedback and old owners cannot release replacements', t => {
  const inbox = setup(t)
  const oldClaim = inbox.claim(1)[0]!
  inbox.finish(oldClaim, { text: 'waiting', wait })
  inbox.ingest('feedback', 'issue_comment', { repository: { full_name: repository }, action: 'created',
    issue: { number: 7, pull_request: {} }, comment: { id: 20, body: 'A new repair is needed' } })
  assert.equal(inbox.claim(1).length, 0)
  const observed = inbox.get(repository, 7)!
  assert.equal(inbox.wake(observed, `feedback:${observed.comments['20']!.body}`), true)
  const replacement = inbox.claim(1)[0]!
  assert.equal(inbox.finish(oldClaim, { text: 'stale', wait }), false)
  assert.equal(inbox.get(repository, 7)!.lease, replacement.token)
})

test('a PR closed during work stays terminal when stale wait completion releases its lease', t => {
  const inbox = setup(t)
  const claim = inbox.claim(1)[0]!
  inbox.seed(repository, { ...pr, state: 'closed' })
  assert.equal(inbox.finish(claim, { text: 'stale', wait }), false)
  assert.equal(inbox.get(repository, 7)!.lease, null)
  assert.equal(inbox.get(repository, 7)!.status, 'terminal')
  assert.equal(inbox.claim(1).length, 0)
})
