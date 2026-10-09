import { test } from 'vitest'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PullRequestInbox, normalizePullRequest } from '../src/server/github-inbox.ts'
const repository = 'vite-hub/vitehub'
const repo = { full_name: repository }
const pr = (patch = {}) => ({ number: 7, state: 'open', user: { login: 'onmax' }, head: { sha: 'a', ref: 'fix' }, base: { sha: 'base', ref: 'main' }, updated_at: '2026-09-13T10:00:00Z', ...patch })
const comment = (id = 1, body = 'Please repair this') => ({ id, body, user: { login: 'human', type: 'User' } })
function memory(t: { onTestFinished: (fn: () => void) => void }) { const inbox = new PullRequestInbox({path: ':memory:', repositories: [repository], activityAuthors: ['vitehub-bot[bot]']}); t.onTestFinished(() => inbox.close()); return inbox }
async function post(inbox: PullRequestInbox, id: string, event: string, payload: object) { return await inbox.ingest(id, event, { repository: repo, ...payload }) }

test('GraphQL bootstrap normalizes state, author and head into a claimable snapshot', async t => {
  const inbox = memory(t)
  await inbox.seed(repository, { number: 7, state: 'OPEN', author: { login: 'onmax' }, headRefOid: 'a', headRefName: 'fix', baseRefName: 'main', updatedAt: '2026-09-13T10:00:00Z' })
  const [claim] = await inbox.claim(1)
  assert.equal(claim?.snapshot.pr?.head?.sha, 'a')
  assert.equal(claim?.snapshot.pr?.state, 'open')
})
test('summary marks dirty stacked children as blocked by their open parent', async t => {
  const inbox = memory(t)
  await inbox.seed(repository, pr({ number: 1, head: { sha: 'parent-sha', ref: 'parent', repo } }))
  await inbox.seed(repository, pr({ number: 2, head: { sha: 'child-sha', ref: 'child' }, base: { sha: 'base', ref: 'parent' } }))
  const child = (await inbox.summary()).find(item => item.number === 2)!
  assert.equal(child.stackBlocked, true)
  assert.deepEqual(child.stackParent, { number: 1, state: 'open' })
  assert.ok(!(await inbox.claim(2)).some(claim => claim.snapshot.number === 2))
})
test('delivery dedupe and three comments coalesce into one claim', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr())
  for (let n = 1; n <= 3; n++) await post(inbox, String(n), 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment(n) })
  const before = (await inbox.get(repository, 7))!
  const duplicate = await post(inbox, '1', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment(1) })
  assert.equal('duplicate' in duplicate && duplicate.duplicate, true)
  assert.equal((await inbox.get(repository, 7))!.generation, before.generation)
  assert.equal(Object.keys(before.comments).length, 3)
  assert.equal((await inbox.claim(6)).length, 1); assert.equal((await inbox.claim(6)).length, 0)
})
test('unknown PR comments survive until its PR metadata arrives', async t => {
  const inbox = memory(t)
  await post(inbox, 'comment', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment() })
  const [claim] = await inbox.claim(1); assert.ok(claim); assert.equal(claim.snapshot.pr, null)
  assert.ok(await inbox.hydrate(claim, { pr: pr(), refresh: false }))
  assert.equal((await inbox.get(repository, 7))?.comments['1']?.body, 'Please repair this')
})
test('status and check events match local head even without pull_requests', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr())
  assert.deepEqual((await post(inbox, 'status', 'status', { sha: 'a', context: 'CI', state: 'failure' })).queued, [7])
  assert.deepEqual((await post(inbox, 'check', 'check_run', { action: 'completed', check_run: { id: 1, head_sha: 'a', conclusion: 'success' } })).queued, [7])
  assert.equal((await inbox.get(repository, 7))?.statuses.CI?.state, 'failure')
})
test('synchronize clears old-head checks and stale CI cannot dirty current head', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr())
  await post(inbox, 'check', 'check_run', { check_run: { id: 1, head_sha: 'a', conclusion: 'failure' } })
  await post(inbox, 'sync', 'pull_request', { action: 'synchronize', pull_request: pr({ head: { sha: 'b', ref: 'fix' }, updated_at: '2026-09-13T11:00:00Z' }) })
  assert.equal((await inbox.get(repository, 7))?.pr?.head?.sha, 'b'); assert.deepEqual((await inbox.get(repository, 7))?.checks, {})
  const generation = (await inbox.get(repository, 7))!.generation
  assert.deepEqual((await post(inbox, 'late', 'check_run', { check_run: { id: 1, head_sha: 'a', pull_requests: [{ number: 7 }] } })).queued, [])
  assert.equal((await inbox.get(repository, 7))!.generation, generation)
})
test('new event during claim is preserved when old pass finishes', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr()); const [claim] = await inbox.claim(1); assert.ok(claim)
  await post(inbox, 'new', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment() })
  assert.equal(await inbox.hydrate(claim, { comments: {} }), false)
  await inbox.finish(claim, { text: 'done' }); assert.equal((await inbox.claim(1)).length, 1)
})
test('a verified resolution retains concurrent feedback without renewing the old claim', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr()); const [claim] = await inbox.claim(1); assert.ok(claim)
  assert.ok(await inbox.hydrate(claim, { threads: [{ id: 'thread', isResolved: false, comments: [] }], threadsHydrated: true }))
  const observed = structuredClone(claim.snapshot)
  await post(inbox, 'new-feedback', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment() })
  assert.equal(await inbox.recordThreadResolution(claim, 'thread', observed), true)
  assert.equal(await inbox.isClaimCurrent(claim), false)
  assert.equal(await inbox.finish(claim, { text: 'Old feedback reviewed', wait: { reason: 'checks', evidenceKey: 'old-feedback' } }), false)
  const [next] = await inbox.claim(1); assert.ok(next)
  assert.equal(next.snapshot.threads[0]?.isResolved, true)
  assert.equal(next.snapshot.comments['1']?.body, 'Please repair this')
})
for (const change of ['head', 'closure', 'release', 'reopen', 'source push']) test(`a verified resolution cannot override ${change} received during the mutation`, async t => {
  const inbox = memory(t); await inbox.seed(repository, pr()); const [claim] = await inbox.claim(1); assert.ok(claim)
  assert.ok(await inbox.hydrate(claim, { threads: [{ id: 'thread', isResolved: false, comments: [] }], threadsHydrated: true }))
  const observed = structuredClone(claim.snapshot)
  if (change === 'head') await post(inbox, 'head-changed', 'pull_request', { action: 'synchronize', pull_request: pr({ head: { sha: 'b', ref: 'fix' }, updated_at: '2026-09-13T11:00:00Z' }) })
  else if (change === 'closure') await post(inbox, 'closed', 'pull_request', { action: 'closed', pull_request: pr({ state: 'closed', updated_at: '2026-09-13T11:00:00Z' }) })
  else if (change === 'release') await inbox.release(claim)
  else if (change === 'source push') await post(inbox, 'source-changed', 'push', { ref: 'refs/heads/fix', after: 'b'.repeat(40) })
  else {
    await post(inbox, 'resolved', 'pull_request_review_thread', { action: 'resolved', pull_request: pr(), thread: { node_id: 'thread', comments: [] } })
    await post(inbox, 'reopened', 'pull_request_review_thread', { action: 'unresolved', pull_request: pr(), thread: { node_id: 'thread', comments: [] } })
  }
  assert.equal(await inbox.recordThreadResolution(claim, 'thread', observed), false)
  assert.notEqual((await inbox.get(repository, 7))?.threads[0]?.isResolved, true)
})
test('a verified resolution cannot use an expired lease', async t => {
  let now = Date.now()
  const inbox = new PullRequestInbox({ path: ':memory:', repositories: [repository], clock: () => now })
  t.onTestFinished(() => inbox.close())
  await inbox.seed(repository, pr()); const [claim] = await inbox.claim(1); assert.ok(claim)
  assert.ok(await inbox.hydrate(claim, { threads: [{ id: 'thread', isResolved: false, comments: [] }], threadsHydrated: true }))
  now = claim.snapshot.leaseUntil + 1
  assert.equal(await inbox.recordThreadResolution(claim, 'thread', claim.snapshot), false)
  assert.equal((await inbox.get(repository, 7))?.threads[0]?.isResolved, false)
})
test('close then reopen during active claim is not lost by stale terminal result', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr()); const [claim] = await inbox.claim(1); assert.ok(claim)
  await post(inbox, 'close', 'pull_request', { action: 'closed', pull_request: pr({ state: 'closed', updated_at: '2026-09-13T11:00:00Z' }) })
  await post(inbox, 'reopen', 'pull_request', { action: 'reopened', pull_request: pr({ updated_at: '2026-09-13T12:00:00Z' }) })
  await inbox.finish(claim, { text: 'stale close', terminal: true }); assert.equal((await inbox.claim(1)).length, 1)
})
test('comment deletion updates projection even if GitHub sends identical body', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr())
  await post(inbox, 'add', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment() })
  await post(inbox, 'del', 'issue_comment', { action: 'deleted', issue: { number: 7, pull_request: {} }, comment: comment() })
  assert.equal((await inbox.get(repository, 7))?.comments['1']?.deleted, true)
})
test('stale bootstrap cannot reopen terminal PR', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr({ state: 'closed', updated_at: '2026-09-13T12:00:00Z' }))
  await inbox.seed(repository, pr()); assert.equal((await inbox.claim(1)).length, 0)
})
test('own activity and issue comments do not wake PR agents; AI review does', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr()); const [claim] = await inbox.claim(1); assert.ok(claim); await inbox.finish(claim, { text: 'wait' })
  await post(inbox, 'own', 'issue_comment', { issue: { number: 7, pull_request: {} }, comment: { ...comment(), body: '<!-- vitehub-agent-activity: --> Working', user: { login: 'vitehub-bot[bot]', type: 'Bot' } } })
  await post(inbox, 'issue', 'issue_comment', { issue: { number: 7 }, comment: comment() })
  assert.equal((await inbox.claim(1)).length, 0)
  await post(inbox, 'ai', 'pull_request_review', { pull_request: pr(), review: { ...comment(), user: { login: 'pullfrog[bot]', type: 'Bot' } } })
  assert.equal((await inbox.claim(1)).length, 1)
})
test('trusted repair comments remain feedback without revoking the claim or waking completed work', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr()); const [claim] = await inbox.claim(1); assert.ok(claim)
  const repair = { ...comment(), body: '<!-- vitehub-babysitter-repair:7 --> Repaired the failure', user: { login: 'vitehub-bot[bot]', type: 'Bot' } }
  assert.deepEqual((await post(inbox, 'repair', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: repair })).queued, [])
  assert.equal((await inbox.get(repository, 7))?.comments['1']?.body, repair.body)
  assert.equal((await inbox.get(repository, 7))?.generation, claim.generation)
  assert.ok(await inbox.renew(claim, Date.now() + 60_000))
  await inbox.finish(claim, { text: 'wait' })
  await post(inbox, 'late-repair', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: { ...repair, id: 2 } })
  assert.equal((await inbox.claim(1)).length, 0)
  await post(inbox, 'untrusted-repair', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: { ...repair, id: 3, user: { login: 'other', type: 'User' } } })
  assert.equal((await inbox.claim(1)).length, 1)
})
test('released claim is immediately reusable without handling the generation', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr()); const [claim] = await inbox.claim(1); assert.ok(claim)
  assert.ok(await inbox.release(claim)); const [next] = await inbox.claim(1); assert.ok(next)
  assert.equal(next.generation, claim.generation); assert.notEqual(next.token, claim.token)
})
test('snapshot and delivery dedupe persist over restart; abandoned lease recovers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-test-')); const path = join(dir, 'state.sqlite')
  try {
    const first = new PullRequestInbox({path, repositories: [repository], clock: () => 0}); await post(first, 'open', 'pull_request', { action: 'opened', pull_request: pr() }); assert.equal((await first.claim(1)).length, 1); await first.close()
    const second = new PullRequestInbox({path, repositories: [repository], clock: () => 3 * 60 * 60_000}); await second.recoverLeases()
    assert.equal((await second.claim(1)).length, 1); const result = await post(second, 'open', 'pull_request', { action: 'opened', pull_request: pr() }); assert.equal('duplicate' in result && result.duplicate, true); await second.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('thread resolution webhook persists explicit state and links feedback comments', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr())
  const result = await post(inbox, 'resolved', 'pull_request_review_thread', { action: 'resolved', pull_request: pr(), thread: { node_id: 'PRRT_1', comments: [comment()] } })
  assert.deepEqual(result.queued, [7])
  assert.equal((await inbox.get(repository, 7))?.threads[0]?.id, 'PRRT_1')
  assert.equal((await inbox.get(repository, 7))?.threads[0]?.isResolved, true)
  assert.equal((await inbox.get(repository, 7))?.threads[0]?.resolutionSource, 'webhook')
  assert.equal((await inbox.get(repository, 7))?.reviewComments['1']?.body, 'Please repair this')
  await post(inbox, 'unresolved', 'pull_request_review_thread', { action: 'unresolved', pull_request: pr(), thread: { node_id: 'PRRT_1', comments: [comment()] } })
  assert.equal((await inbox.get(repository, 7))?.threads.length, 1)
  assert.equal((await inbox.get(repository, 7))?.threads[0]?.isResolved, false)
})
test('unknown historical comments remain unknown when another thread is resolved', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr())
  await post(inbox, 'unknown-comment', 'pull_request_review_comment', { action: 'created', pull_request: pr(), comment: comment(2) })
  await post(inbox, 'resolved', 'pull_request_review_thread', { action: 'resolved', pull_request: pr(), thread: { node_id: 'PRRT_1', comments: [comment(1)] } })
  const snapshot = (await inbox.get(repository, 7))!
  assert.equal(snapshot.reviewComments['2']?.id, 2)
  assert.equal(snapshot.reviewComments['2']?.isResolved, undefined)
  assert.equal(snapshot.threads.some(thread => Array.isArray(thread.comments) && thread.comments.some(item => item.id === 2)), false)
})
test('equivalent thread delivery does not wake waiting agent again', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr())
  const payload = { action: 'resolved', pull_request: pr(), thread: { node_id: 'PRRT_1', comments: [comment()] } }
  await post(inbox, 'resolved-1', 'pull_request_review_thread', payload)
  const [claim] = await inbox.claim(1); assert.ok(claim); await inbox.finish(claim, { text: 'wait' })
  const generation = (await inbox.get(repository, 7))!.generation
  assert.deepEqual((await post(inbox, 'resolved-2', 'pull_request_review_thread', payload)).queued, [])
  assert.equal((await inbox.get(repository, 7))!.generation, generation); assert.equal((await inbox.claim(1)).length, 0)
})
test('thread webhook merges GraphQL baseline comments and rejects stale comment body', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr())
  const [claim] = await inbox.claim(1); assert.ok(claim)
  await inbox.hydrate(claim, { threads: [{ id: 'PRRT_1', isResolved: false, comments: { nodes: [{ id: 'PRRC_1', body: 'new', updatedAt: '2026-09-13T12:00:00Z' }] } }] })
  await post(inbox, 'resolved', 'pull_request_review_thread', { action: 'resolved', pull_request: pr(), thread: { node_id: 'PRRT_1', comments: [{ ...comment(), node_id: 'PRRC_1', body: 'old', updated_at: '2026-09-13T11:00:00Z' }] } })
  const thread = (await inbox.get(repository, 7))!.threads[0]!
  assert.equal(thread.isResolved, true); assert.ok(Array.isArray(thread.comments)); assert.equal(thread.comments.length, 1); assert.equal(thread.comments[0]!.body, 'new')
})

test('queued and running CI persist without waking, failure and final green wake', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr())
  await inbox.finish((await inbox.claim(1))[0]!, { text: 'Waiting for CI' })
  const generation = (await inbox.get(repository, 7))!.generation
  for (const status of ['queued', 'in_progress']) {
    assert.deepEqual((await post(inbox, status, 'check_run', { action: status === 'queued' ? 'created' : 'in_progress', check_run: { id: 1, head_sha: 'a', status, conclusion: null } })).queued, [])
    assert.equal((await inbox.get(repository, 7))?.checks['check_run:1']?.status, status)
    assert.equal((await inbox.get(repository, 7))!.generation, generation); assert.equal((await inbox.claim(1)).length, 0)
  }
  assert.deepEqual((await post(inbox, 'failure', 'check_run', { action: 'completed', check_run: { id: 1, head_sha: 'a', status: 'completed', conclusion: 'failure' } })).queued, [7])
  await inbox.finish((await inbox.claim(1))[0]!, { text: 'Repair pushed' })
  assert.deepEqual((await post(inbox, 'green', 'check_run', { action: 'completed', check_run: { id: 1, head_sha: 'a', status: 'completed', conclusion: 'success' } })).queued, [7])
  assert.equal((await inbox.claim(1)).length, 1)
})
test('pending status does not wake but invalidates in-flight stale hydration', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr()); const claim = (await inbox.claim(1))[0]!
  await post(inbox, 'pending-status', 'status', { sha: 'a', context: 'deploy', state: 'pending' })
  assert.equal((await inbox.get(repository, 7))!.generation, claim.generation)
  assert.equal(await inbox.hydrate(claim, { statuses: {} }), false)
  assert.equal((await inbox.get(repository, 7))?.statuses.deploy?.state, 'pending')
  await inbox.finish(claim, { text: 'wait' }); assert.equal((await inbox.claim(1)).length, 0)
})
test('thread reconcile preserves concurrent webhook and only wakes on changed evidence', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr()); await inbox.finish((await inbox.claim(1))[0]!, { text: 'wait' })
  const thread = { id: 'PRRT_1', isResolved: true, comments: [] }
  assert.equal(await inbox.refreshThreads((await inbox.get(repository, 7))!, [thread]), true)
  await inbox.finish((await inbox.claim(1))[0]!, { text: 'read' })
  assert.equal(await inbox.refreshThreads((await inbox.get(repository, 7))!, [thread]), true); assert.equal((await inbox.claim(1)).length, 0)
  const observed = (await inbox.get(repository, 7))!
  await post(inbox, 'unresolved-thread', 'pull_request_review_thread', { action: 'unresolved', pull_request: pr(), thread: { node_id: 'PRRT_1', comments: [] } })
  assert.equal(await inbox.refreshThreads(observed, [thread]), false)
  assert.equal((await inbox.get(repository, 7))?.threads[0]?.isResolved, false)
})

test('unknown reviewer bot retains full review and inline body while own issue activity stays ignored', async t => {
  const inbox = memory(t); await inbox.seed(repository, pr())
  const user = { login: 'new-reviewer-service[bot]', type: 'Bot' }
  await post(inbox, 'unknown-review', 'pull_request_review', { action: 'submitted', pull_request: pr(), review: { id: 9, user, body: 'Full future reviewer body', state: 'CHANGES_REQUESTED' } })
  await post(inbox, 'unknown-inline', 'pull_request_review_comment', { action: 'created', pull_request: pr(), comment: { id: 10, node_id: 'inline-node', user, body: 'Full future inline body' } })
  await post(inbox, 'unknown-thread', 'pull_request_review_thread', { action: 'unresolved', pull_request: pr(), thread: { node_id: 'thread-node', comments: [{ id: 11, node_id: 'thread-inline-node', user, body: 'Full thread-delivered body' }] } })
  assert.equal((await inbox.get(repository, 7))?.reviews['9']?.body, 'Full future reviewer body')
  assert.equal((await inbox.get(repository, 7))?.reviewComments['10']?.body, 'Full future inline body')
  assert.equal((await inbox.get(repository, 7))?.reviewComments['11']?.body, 'Full thread-delivered body')
  await inbox.finish((await inbox.claim(1))[0]!, { text: 'handled' })
  await post(inbox, 'own-activity', 'issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: { id: 12, user: { login: 'vitehub-bot[bot]', type: 'Bot' }, body: '<!-- vitehub-agent-activity: --> Working' } })
  assert.equal((await inbox.claim(1)).length, 0)
})

test('persistent filters apply to discovery, labels, and claims; event rules only gate admission', async t => {
  const inbox = new PullRequestInbox({path: ':memory:', repositories: [repository], filter: {
    author: { allow: ['alice'] }, labels: { allow: ['repair'], deny: ['hold'] },
    actor: { allow: ['maintainer'] }, action: { allow: ['opened'] },
  }})
  t.onTestFinished(() => inbox.close())
  await inbox.seed(repository, pr({ user: { login: 'alice' }, labels: ['repair'] }))
  const claim = (await inbox.claim(1))[0]!
  assert.ok(claim)
  // Non-admission events still cancel work when eligibility changes.
  await post(inbox, 'label', 'pull_request', { action: 'labeled', sender: {login: 'someone'}, pull_request: pr({user: {login: 'alice'}, labels: ['repair', 'hold'], updated_at: '2026-09-13T11:00:00Z'}) })
  assert.equal((await inbox.get(repository, 7))?.status, 'terminal')
  await inbox.finish(claim, {text: 'stopped'})
  assert.equal((await inbox.claim(1)).length, 0)
  await post(inbox, 'remove-label', 'pull_request', { action: 'unlabeled', pull_request: pr({user: {login: 'alice'}, labels: ['repair'], updated_at: '2026-09-13T12:00:00Z'}) })
  assert.equal((await inbox.claim(1)).length, 1)
  await post(inbox, 'new', 'pull_request', {action: 'opened', sender: {login: 'someone'}, pull_request: pr({number: 8, user: {login: 'alice'}, labels: ['repair']})})
  assert.equal(await inbox.get(repository, 8), undefined)
})

test('another process cannot recover a live lease, and an expired owner cannot finish the replacement claim', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'github-inbox-'))
  let now = 0
  const path = join(dir, 'inbox.sqlite')
  const first = new PullRequestInbox({path, repositories: [repository], clock: () => now})
  const second = new PullRequestInbox({path, repositories: [repository], clock: () => now})
  t.onTestFinished(async () => {await first.close(); await second.close(); rmSync(dir, {recursive: true, force: true})})
  await first.seed(repository, pr())
  const original = (await first.claim(1))[0]!
  await second.recoverLeases()
  assert.equal((await second.claim(1)).length, 0)
  now = 3 * 60 * 60_000
  await second.recoverLeases()
  const replacement = (await second.claim(1))[0]!
  assert.ok(replacement)
  assert.notEqual(replacement.token, original.token)
  assert.equal(await first.finish(original, {text: 'stale'}), false)
  assert.equal(await first.hydrate(original, {comments: {}}), false)
})

test('unknown bots and former hardcoded own bot names remain feedback without the activity marker', async t => {
  const inbox = memory(t)
  await inbox.seed(repository, pr({user: {login: 'other-author'}}))
  for (const [id, login] of ['new-bot[bot]', 'pkg-pr-new[bot]', 'vitehub-bot[bot]'].entries()) {
    await post(inbox, String(id), 'issue_comment', {action: 'created', issue: {number: 7, pull_request: {}}, comment: {id, user: {login, type: 'Bot'}, body: 'Please fix'}})
  }
  assert.equal(Object.keys((await inbox.get(repository, 7))!.comments).length, 3)
})


test('operation snapshots preserve author association and all durable filter fields', async t => {
  const inbox = new PullRequestInbox({path: ':memory:', repositories: [repository], filter: {
    repository: {allow: [repository]}, author: {allow: ['alice']}, authorAssociation: {allow: ['MEMBER']},
    labels: {allow: ['repair']}, draft: {allow: ['false']}, fork: {allow: ['true']},
    base: {allow: ['main']}, head: {allow: ['fix']}, title: {allow: ['Fix bug']},
  }})
  t.onTestFinished(() => inbox.close())
  const value = normalizePullRequest({number: 7, state: 'OPEN', author: {login: 'alice', __typename: 'User'}, authorAssociation: 'MEMBER', labels: ['repair'], isDraft: false, headRefOid: 'a', headRefName: 'fix', baseRefName: 'main', headRepository: {nameWithOwner: 'alice/fork'}, title: 'Fix bug'})
  assert.equal(value.author_association, 'MEMBER')
  assert.equal(inbox.eligible(repository, value), true)
  await inbox.seed(repository, value)
  assert.equal((await inbox.claim(1)).length, 1)
})


test('review deliveries advance PR metadata when the synchronize delivery was missed', async t => {
  const inbox = memory(t)
  await inbox.seed(repository, pr())
  const claim = (await inbox.claim(1))[0]!
  await inbox.hydrate(claim, {hydrated: true, refresh: false, checks: {old: {id: 1, head_sha: 'a'}}})
  await inbox.finish(claim, {text: 'waiting'})
  await post(inbox, 'new-head-review', 'pull_request_review', { action: 'submitted', pull_request: pr({head: {sha: 'b', ref: 'fix'}, updated_at: '2026-09-13T11:00:00Z'}), review: {id: 4, body: 'Fix on the new head', commit_id: 'b'} })
  const next = (await inbox.claim(1))[0]!
  assert.equal(next.snapshot.pr?.head?.sha, 'b')
  assert.equal(next.snapshot.hydrated, false)
  assert.deepEqual(next.snapshot.checks, {})
  await post(inbox, 'late-old-review', 'pull_request_review', {action: 'submitted', pull_request: pr(), review: {id: 5, body: 'Historical', commit_id: 'a'}})
  assert.equal((await inbox.get(repository, 7))?.pr?.head?.sha, 'b')
})


test('timestamp-only PR evidence prevents stale hydration and late head regression without waking', async t => {
  const inbox = memory(t)
  await inbox.seed(repository, pr())
  const claim = (await inbox.claim(1))[0]!
  await post(inbox, 'fresh-time', 'pull_request', {action: 'edited', pull_request: pr({updated_at: '2026-09-13T12:00:00Z'})})
  assert.equal((await inbox.get(repository, 7))?.generation, claim.generation)
  assert.equal(await inbox.hydrate(claim, {pr: pr()}), false)
  await post(inbox, 'late-head', 'pull_request', {action: 'synchronize', pull_request: pr({head: {sha: 'old', ref: 'fix'}, updated_at: '2026-09-13T11:00:00Z'})})
  assert.equal((await inbox.get(repository, 7))?.pr?.head?.sha, 'a')
  await inbox.release(claim)
  const fresh = (await inbox.claim(1))[0]!
  assert.equal(await inbox.hydrate(fresh, {pr: pr()}), false)
})

test('timestamp-only comment evidence also invalidates hydration without another repair generation', async t => {
  const inbox = memory(t)
  await inbox.seed(repository, pr())
  const payload = {action: 'edited', issue: {number: 7, pull_request: {}}, comment: {...comment(), updated_at: '2026-09-13T10:00:00Z'}}
  await post(inbox, 'original-comment', 'issue_comment', payload)
  const claim = (await inbox.claim(1))[0]!
  await post(inbox, 'fresh-comment', 'issue_comment', {...payload, comment: {...payload.comment, updated_at: '2026-09-13T11:00:00Z'}})
  assert.equal((await inbox.get(repository, 7))?.generation, claim.generation)
  assert.equal(await inbox.hydrate(claim, {comments: {'1': payload.comment}}), false)
})

test('persisted status values are validated without coercion by both snapshot readers', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'inbox-status-'))
  const path = join(directory, 'inbox.sqlite')
  const inbox = new PullRequestInbox({ path, repositories: [repository] })
  const db = new DatabaseSync(path)
  t.onTestFinished(async () => { db.close(); await inbox.close(); rmSync(directory, { recursive: true, force: true }) })
  await inbox.seed(repository, pr())
  const snapshot = (await inbox.get(repository, 7))!
  const update = db.prepare('UPDATE vitehub_babysitter_pull_requests SET value=? WHERE repository=? AND number=?')
  for (const status of ['ready', 'working', 'waiting', 'terminal']) {
    update.run(JSON.stringify({ ...snapshot, status }), repository, 7)
    assert.equal((await inbox.get(repository, 7))?.status, status)
    assert.equal((await inbox.all())[0]?.status, status)
    update.run(JSON.stringify({ ...snapshot, status: [status] }), repository, 7)
    await assert.rejects(async () => inbox.get(repository, 7), /Invalid inbox snapshot/)
    await assert.rejects(async () => inbox.all(), /Invalid inbox snapshot/)
  }
})

test('fork branch names do not block unrelated stack children', async t => {
  const inbox = memory(t)
  await inbox.seed(repository, pr({ number: 1, head: { sha: 'parent', ref: 'feature', repo: { full_name: 'fork/vitehub' } } }))
  await inbox.seed(repository, pr({ number: 2, head: { sha: 'child', ref: 'child' }, base: { ref: 'feature', repo } }))
  assert.equal((await inbox.summary()).find(item => item.number === 2)!.stackBlocked, undefined)
  assert.ok((await inbox.claim(2)).some(claim => claim.snapshot.number === 2))
})
