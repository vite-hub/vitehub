import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PullRequestInbox } from '../src/server/github-inbox.ts'
const repository = 'vite-hub/vitehub'
const repo = { full_name: repository }
const pr = (patch = {}) => ({ number: 7, state: 'open', user: { login: 'onmax' }, head: { sha: 'a', ref: 'fix' }, base: { sha: 'base', ref: 'main' }, updated_at: '2026-09-13T10:00:00Z', ...patch })
const comment = (id = 1, body = 'Please repair this') => ({ id, body, user: { login: 'human', type: 'User' } })
function memory(t: { onTestFinished: (fn: () => void) => void }) { const inbox = new PullRequestInbox({path: ':memory:', repositories: [repository]}); t.onTestFinished(() => inbox.close()); return inbox }
function post(inbox: PullRequestInbox, id: string, event: string, payload: object) { return inbox.ingest(id, event, { repository: repo, ...payload }) }

test('GraphQL bootstrap normalizes state, author and head into a claimable snapshot', t => {
  const inbox = memory(t)
  inbox.seed(repository, { number: 7, state: 'OPEN', author: { login: 'onmax' }, headRefOid: 'a', headRefName: 'fix', baseRefName: 'main', updatedAt: '2026-09-13T10:00:00Z' })
  const [claim] = inbox.claim(1)
  assert.equal(claim?.snapshot.pr?.head?.sha, 'a')
  assert.equal(claim?.snapshot.pr?.state, 'open')
})
test('delivery dedupe and three comments coalesce into one claim', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  for (let n = 1; n <= 3; n++) post(inbox, String(n), 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment(n) })
  const before = inbox.get(repository, 7)!
  const duplicate = post(inbox, '1', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment(1) })
  assert.equal('duplicate' in duplicate && duplicate.duplicate, true)
  assert.equal(inbox.get(repository, 7)!.generation, before.generation)
  assert.equal(Object.keys(before.comments).length, 3)
  assert.equal(inbox.claim(6).length, 1); assert.equal(inbox.claim(6).length, 0)
})
test('unknown PR comments survive until its PR metadata arrives', t => {
  const inbox = memory(t)
  post(inbox, 'comment', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment() })
  const [claim] = inbox.claim(1); assert.ok(claim); assert.equal(claim.snapshot.pr, null)
  assert.ok(inbox.hydrate(claim, { pr: pr(), refresh: false }))
  assert.equal(inbox.get(repository, 7)?.comments['1']?.body, 'Please repair this')
})
test('status and check events match local head even without pull_requests', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  assert.deepEqual(post(inbox, 'status', 'status', { sha: 'a', context: 'CI', state: 'failure' }).queued, [7])
  assert.deepEqual(post(inbox, 'check', 'check_run', { action: 'completed', check_run: { id: 1, head_sha: 'a', conclusion: 'success' } }).queued, [7])
  assert.equal(inbox.get(repository, 7)?.statuses.CI?.state, 'failure')
})
test('synchronize clears old-head checks and stale CI cannot dirty current head', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  post(inbox, 'check', 'check_run', { check_run: { id: 1, head_sha: 'a', conclusion: 'failure' } })
  post(inbox, 'sync', 'pull_request', { action: 'synchronize', pull_request: pr({ head: { sha: 'b', ref: 'fix' }, updated_at: '2026-09-13T11:00:00Z' }) })
  assert.equal(inbox.get(repository, 7)?.pr?.head?.sha, 'b'); assert.deepEqual(inbox.get(repository, 7)?.checks, {})
  const generation = inbox.get(repository, 7)!.generation
  assert.deepEqual(post(inbox, 'late', 'check_run', { check_run: { id: 1, head_sha: 'a', pull_requests: [{ number: 7 }] } }).queued, [])
  assert.equal(inbox.get(repository, 7)!.generation, generation)
})
test('new event during claim is preserved when old pass finishes', t => {
  const inbox = memory(t); inbox.seed(repository, pr()); const [claim] = inbox.claim(1); assert.ok(claim)
  post(inbox, 'new', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment() })
  assert.equal(inbox.hydrate(claim, { comments: {} }), false)
  inbox.finish(claim, { text: 'done' }); assert.equal(inbox.claim(1).length, 1)
})
test('close then reopen during active claim is not lost by stale terminal result', t => {
  const inbox = memory(t); inbox.seed(repository, pr()); const [claim] = inbox.claim(1); assert.ok(claim)
  post(inbox, 'close', 'pull_request', { action: 'closed', pull_request: pr({ state: 'closed', updated_at: '2026-09-13T11:00:00Z' }) })
  post(inbox, 'reopen', 'pull_request', { action: 'reopened', pull_request: pr({ updated_at: '2026-09-13T12:00:00Z' }) })
  inbox.finish(claim, { text: 'stale close', terminal: true }); assert.equal(inbox.claim(1).length, 1)
})
test('comment deletion updates projection even if GitHub sends identical body', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  post(inbox, 'add', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment() })
  post(inbox, 'del', 'issue_comment', { action: 'deleted', issue: { number: 7, pull_request: {} }, comment: comment() })
  assert.equal(inbox.get(repository, 7)?.comments['1']?.deleted, true)
})
test('stale bootstrap cannot reopen terminal PR', t => {
  const inbox = memory(t); inbox.seed(repository, pr({ state: 'closed', updated_at: '2026-09-13T12:00:00Z' }))
  inbox.seed(repository, pr()); assert.equal(inbox.claim(1).length, 0)
})
test('own activity and issue comments do not wake PR agents; AI review does', t => {
  const inbox = memory(t); inbox.seed(repository, pr()); const [claim] = inbox.claim(1); assert.ok(claim); inbox.finish(claim, { text: 'wait' })
  post(inbox, 'own', 'issue_comment', { issue: { number: 7, pull_request: {} }, comment: { ...comment(), body: '<!-- vitehub-agent-activity: --> Working', user: { login: 'vitehub-bot[bot]', type: 'Bot' } } })
  post(inbox, 'issue', 'issue_comment', { issue: { number: 7 }, comment: comment() })
  assert.equal(inbox.claim(1).length, 0)
  post(inbox, 'ai', 'pull_request_review', { pull_request: pr(), review: { ...comment(), user: { login: 'pullfrog[bot]', type: 'Bot' } } })
  assert.equal(inbox.claim(1).length, 1)
})
test('released claim is immediately reusable without handling the generation', t => {
  const inbox = memory(t); inbox.seed(repository, pr()); const [claim] = inbox.claim(1); assert.ok(claim)
  assert.ok(inbox.release(claim)); const [next] = inbox.claim(1); assert.ok(next)
  assert.equal(next.generation, claim.generation); assert.notEqual(next.token, claim.token)
})
test('snapshot and delivery dedupe persist over restart; abandoned lease recovers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-test-')); const path = join(dir, 'state.sqlite')
  try {
    const first = new PullRequestInbox({path, repositories: [repository], clock: () => 0}); post(first, 'open', 'pull_request', { action: 'opened', pull_request: pr() }); assert.equal(first.claim(1).length, 1); first.close()
    const second = new PullRequestInbox({path, repositories: [repository], clock: () => 3 * 60 * 60_000}); second.recoverLeases()
    assert.equal(second.claim(1).length, 1); const result = post(second, 'open', 'pull_request', { action: 'opened', pull_request: pr() }); assert.equal('duplicate' in result && result.duplicate, true); second.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('thread resolution webhook persists explicit state and links feedback comments', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  const result = post(inbox, 'resolved', 'pull_request_review_thread', { action: 'resolved', pull_request: pr(), thread: { node_id: 'PRRT_1', comments: [comment()] } })
  assert.deepEqual(result.queued, [7])
  assert.equal(inbox.get(repository, 7)?.threads[0]?.id, 'PRRT_1')
  assert.equal(inbox.get(repository, 7)?.threads[0]?.isResolved, true)
  assert.equal(inbox.get(repository, 7)?.threads[0]?.resolutionSource, 'webhook')
  assert.equal(inbox.get(repository, 7)?.reviewComments['1']?.body, 'Please repair this')
  post(inbox, 'unresolved', 'pull_request_review_thread', { action: 'unresolved', pull_request: pr(), thread: { node_id: 'PRRT_1', comments: [comment()] } })
  assert.equal(inbox.get(repository, 7)?.threads.length, 1)
  assert.equal(inbox.get(repository, 7)?.threads[0]?.isResolved, false)
})
test('unknown historical comments remain unknown when another thread is resolved', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  post(inbox, 'unknown-comment', 'pull_request_review_comment', { action: 'created', pull_request: pr(), comment: comment(2) })
  post(inbox, 'resolved', 'pull_request_review_thread', { action: 'resolved', pull_request: pr(), thread: { node_id: 'PRRT_1', comments: [comment(1)] } })
  const snapshot = inbox.get(repository, 7)!
  assert.equal(snapshot.reviewComments['2']?.id, 2)
  assert.equal(snapshot.reviewComments['2']?.isResolved, undefined)
  assert.equal(snapshot.threads.some(thread => Array.isArray(thread.comments) && thread.comments.some(item => item.id === 2)), false)
})
test('equivalent thread delivery does not wake waiting agent again', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  const payload = { action: 'resolved', pull_request: pr(), thread: { node_id: 'PRRT_1', comments: [comment()] } }
  post(inbox, 'resolved-1', 'pull_request_review_thread', payload)
  const [claim] = inbox.claim(1); assert.ok(claim); inbox.finish(claim, { text: 'wait' })
  const generation = inbox.get(repository, 7)!.generation
  assert.deepEqual(post(inbox, 'resolved-2', 'pull_request_review_thread', payload).queued, [])
  assert.equal(inbox.get(repository, 7)!.generation, generation); assert.equal(inbox.claim(1).length, 0)
})
test('thread webhook merges GraphQL baseline comments and rejects stale comment body', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  const [claim] = inbox.claim(1); assert.ok(claim)
  inbox.hydrate(claim, { threads: [{ id: 'PRRT_1', isResolved: false, comments: { nodes: [{ id: 'PRRC_1', body: 'new', updatedAt: '2026-09-13T12:00:00Z' }] } }] })
  post(inbox, 'resolved', 'pull_request_review_thread', { action: 'resolved', pull_request: pr(), thread: { node_id: 'PRRT_1', comments: [{ ...comment(), node_id: 'PRRC_1', body: 'old', updated_at: '2026-09-13T11:00:00Z' }] } })
  const thread = inbox.get(repository, 7)!.threads[0]!
  assert.equal(thread.isResolved, true); assert.ok(Array.isArray(thread.comments)); assert.equal(thread.comments.length, 1); assert.equal(thread.comments[0]!.body, 'new')
})

test('queued and running CI persist without waking, failure and final green wake', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  inbox.finish(inbox.claim(1)[0]!, { text: 'Waiting for CI' })
  const generation = inbox.get(repository, 7)!.generation
  for (const status of ['queued', 'in_progress']) {
    assert.deepEqual(post(inbox, status, 'check_run', { action: status === 'queued' ? 'created' : 'in_progress', check_run: { id: 1, head_sha: 'a', status, conclusion: null } }).queued, [])
    assert.equal(inbox.get(repository, 7)?.checks['check_run:1']?.status, status)
    assert.equal(inbox.get(repository, 7)!.generation, generation); assert.equal(inbox.claim(1).length, 0)
  }
  assert.deepEqual(post(inbox, 'failure', 'check_run', { action: 'completed', check_run: { id: 1, head_sha: 'a', status: 'completed', conclusion: 'failure' } }).queued, [7])
  inbox.finish(inbox.claim(1)[0]!, { text: 'Repair pushed' })
  assert.deepEqual(post(inbox, 'green', 'check_run', { action: 'completed', check_run: { id: 1, head_sha: 'a', status: 'completed', conclusion: 'success' } }).queued, [7])
  assert.equal(inbox.claim(1).length, 1)
})
test('pending status does not wake but invalidates in-flight stale hydration', t => {
  const inbox = memory(t); inbox.seed(repository, pr()); const claim = inbox.claim(1)[0]!
  post(inbox, 'pending-status', 'status', { sha: 'a', context: 'deploy', state: 'pending' })
  assert.equal(inbox.get(repository, 7)!.generation, claim.generation)
  assert.equal(inbox.hydrate(claim, { statuses: {} }), false)
  assert.equal(inbox.get(repository, 7)?.statuses.deploy?.state, 'pending')
  inbox.finish(claim, { text: 'wait' }); assert.equal(inbox.claim(1).length, 0)
})
test('thread reconcile preserves concurrent webhook and only wakes on changed evidence', t => {
  const inbox = memory(t); inbox.seed(repository, pr()); inbox.finish(inbox.claim(1)[0]!, { text: 'wait' })
  const thread = { id: 'PRRT_1', isResolved: true, comments: [] }
  assert.equal(inbox.refreshThreads(inbox.get(repository, 7)!, [thread]), true)
  inbox.finish(inbox.claim(1)[0]!, { text: 'read' })
  assert.equal(inbox.refreshThreads(inbox.get(repository, 7)!, [thread]), true); assert.equal(inbox.claim(1).length, 0)
  const observed = inbox.get(repository, 7)!
  post(inbox, 'unresolved-thread', 'pull_request_review_thread', { action: 'unresolved', pull_request: pr(), thread: { node_id: 'PRRT_1', comments: [] } })
  assert.equal(inbox.refreshThreads(observed, [thread]), false)
  assert.equal(inbox.get(repository, 7)?.threads[0]?.isResolved, false)
})

test('unknown reviewer bot retains full review and inline body while own issue activity stays ignored', t => {
  const inbox = memory(t); inbox.seed(repository, pr())
  const user = { login: 'new-reviewer-service[bot]', type: 'Bot' }
  post(inbox, 'unknown-review', 'pull_request_review', { action: 'submitted', pull_request: pr(), review: { id: 9, user, body: 'Full future reviewer body', state: 'CHANGES_REQUESTED' } })
  post(inbox, 'unknown-inline', 'pull_request_review_comment', { action: 'created', pull_request: pr(), comment: { id: 10, node_id: 'inline-node', user, body: 'Full future inline body' } })
  post(inbox, 'unknown-thread', 'pull_request_review_thread', { action: 'unresolved', pull_request: pr(), thread: { node_id: 'thread-node', comments: [{ id: 11, node_id: 'thread-inline-node', user, body: 'Full thread-delivered body' }] } })
  assert.equal(inbox.get(repository, 7)?.reviews['9']?.body, 'Full future reviewer body')
  assert.equal(inbox.get(repository, 7)?.reviewComments['10']?.body, 'Full future inline body')
  assert.equal(inbox.get(repository, 7)?.reviewComments['11']?.body, 'Full thread-delivered body')
  inbox.finish(inbox.claim(1)[0]!, { text: 'handled' })
  post(inbox, 'own-activity', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: { id: 12, user: { login: 'vitehub-bot[bot]', type: 'Bot' }, body: '<!-- vitehub-agent-activity: --> Working' } })
  assert.equal(inbox.claim(1).length, 0)
})

test('persistent filters apply to discovery, labels, and claims; event rules only gate admission', t => {
  const inbox = new PullRequestInbox({path: ':memory:', repositories: [repository], filter: {
    author: { allow: ['alice'] }, labels: { allow: ['repair'], deny: ['hold'] },
    actor: { allow: ['maintainer'] }, action: { allow: ['opened'] },
  }})
  t.onTestFinished(() => inbox.close())
  inbox.seed(repository, pr({ user: { login: 'alice' }, labels: ['repair'] }))
  const claim = inbox.claim(1)[0]!
  assert.ok(claim)
  // Non-admission events still cancel work when eligibility changes.
  post(inbox, 'label', 'pull_request', { action: 'labeled', sender: {login: 'someone'}, pull_request: pr({user: {login: 'alice'}, labels: ['repair', 'hold'], updated_at: '2026-09-13T11:00:00Z'}) })
  assert.equal(inbox.get(repository, 7)?.status, 'terminal')
  inbox.finish(claim, {text: 'stopped'})
  assert.equal(inbox.claim(1).length, 0)
  post(inbox, 'remove-label', 'pull_request', { action: 'unlabeled', pull_request: pr({user: {login: 'alice'}, labels: ['repair'], updated_at: '2026-09-13T12:00:00Z'}) })
  assert.equal(inbox.claim(1).length, 1)
  post(inbox, 'new', 'pull_request', {action: 'opened', sender: {login: 'someone'}, pull_request: pr({number: 8, user: {login: 'alice'}, labels: ['repair']})})
  assert.equal(inbox.get(repository, 8), undefined)
})

test('another process cannot recover a live lease, and an expired owner cannot finish the replacement claim', t => {
  const dir = mkdtempSync(join(tmpdir(), 'github-inbox-'))
  let now = 0
  const path = join(dir, 'inbox.sqlite')
  const first = new PullRequestInbox({path, repositories: [repository], clock: () => now})
  const second = new PullRequestInbox({path, repositories: [repository], clock: () => now})
  t.onTestFinished(() => {first.close(); second.close(); rmSync(dir, {recursive: true, force: true})})
  first.seed(repository, pr())
  const original = first.claim(1)[0]!
  second.recoverLeases()
  assert.equal(second.claim(1).length, 0)
  now = 3 * 60 * 60_000
  second.recoverLeases()
  const replacement = second.claim(1)[0]!
  assert.ok(replacement)
  assert.notEqual(replacement.token, original.token)
  assert.equal(first.finish(original, {text: 'stale'}), false)
  assert.equal(first.hydrate(original, {comments: {}}), false)
})

test('unknown bots and former hardcoded own bot names remain feedback without the activity marker', t => {
  const inbox = memory(t)
  inbox.seed(repository, pr({user: {login: 'other-author'}}))
  for (const [id, login] of ['new-bot[bot]', 'pkg-pr-new[bot]', 'vitehub-bot[bot]'].entries()) {
    post(inbox, String(id), 'issue_comment', {action: 'created', issue: {number: 7, pull_request: {}}, comment: {id, user: {login, type: 'Bot'}, body: 'Please fix'}})
  }
  assert.equal(Object.keys(inbox.get(repository, 7)!.comments).length, 3)
})
