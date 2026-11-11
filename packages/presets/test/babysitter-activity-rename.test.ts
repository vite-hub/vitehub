import { test } from 'vitest'
import assert from 'node:assert/strict'
import { PullRequestInbox } from '../src/babysitter/inbox/store.ts'

const repository = 'acme/app'
const appId = 4698907
const oldLogin = 'vitehub-bot[bot]'
const newLogin = 'vite-hub[bot]'
const head = 'a'.repeat(40)
const pr = { number: 64, state: 'open', head: { sha: head }, base: { sha: 'b'.repeat(40), ref: 'main' } }
const marker = '<!-- vitehub-agent-activity:eyJoaXN0b3J5IjpbXSwicHJldmlvdXNSdW5JZHMiOltdfQ -->'
const comment = (id: number, login = newLogin, sourceApp = appId, body = `${marker}\n\nNew pull request evidence is queued.`) =>
  ({ id, body, user: { login, type: 'Bot' }, performed_via_github_app: { id: sourceApp }, updated_at: id === 10 ? '2026-10-28T13:00:00Z' : '2026-10-28T18:00:00Z' })

test('renamed App activity webhooks do not wake a waiting PR, while real feedback does', async t => {
  const inbox = new PullRequestInbox({ path: ':memory:', repositories: [repository], activityAuthors: [oldLogin], activityAppId: appId })
  t.onTestFinished(() => inbox.close())
  await inbox.seed(repository, pr)
  const [claim] = await inbox.claim(1)
  assert.ok(claim)
  await inbox.finish(claim, { text: 'Waiting for parent.', wait: { kind: 'external', headSha: head, reason: 'Parent is open.', evidenceKey: 'parent' } })
  const before = await inbox.get(repository, 64)
  const deliver = (id: string, item: ReturnType<typeof comment>) => inbox.ingest(id, 'issue_comment', {
    repository: { full_name: repository }, action: 'edited', issue: { number: 64, pull_request: {} }, comment: item, sender: item.user,
  })
  for (const id of ['first', 'retry']) {
    const result = await deliver(id, comment(10))
    assert.deepEqual(result.updated, [], 'publishing activity must not become new PR evidence')
    assert.deepEqual(result.queued, [])
  }
  const after = await inbox.get(repository, 64)
  assert.equal(after?.generation, before?.generation)
  assert.equal(after?.status, 'waiting')
  assert.deepEqual(after?.comments, {})
  assert.deepEqual((await deliver('foreign', comment(11, 'other[bot]', 99))).updated, [64])
  assert.deepEqual((await deliver('reused-login', comment(13, oldLogin, 99))).updated, [64], 'App ownership takes precedence over a cached login')
  assert.deepEqual((await deliver('real-feedback', comment(12, newLogin, appId, 'P2: handle the empty case.'))).updated, [64])
})

test('a repaired inbox removes persisted App activity and keeps ordinary feedback', async t => {
  const { createNodeSqliteInboxStorage } = await import('../src/babysitter/inbox/storage.ts')
  const storage = createNodeSqliteInboxStorage(':memory:')
  t.onTestFinished(() => storage.close?.())
  const old = new PullRequestInbox({ storage, repositories: [repository], activityAuthors: [oldLogin] })
  await old.seed(repository, pr)
  await old.ingest('polluted', 'issue_comment', { repository: { full_name: repository }, action: 'created', issue: { number: 64, pull_request: {} }, comment: comment(10) })
  const repaired = new PullRequestInbox({ storage, repositories: [repository], activityAuthors: [oldLogin], activityAppId: appId })
  assert.deepEqual((await repaired.get(repository, 64))?.comments, {})
  assert.deepEqual((await repaired.all())[0]?.comments, {})
  const [claim] = await repaired.claim(1)
  assert.ok(claim)
  await repaired.hydrate(claim, { comments: { 10: comment(10), 11: comment(11, newLogin, appId, 'Please fix this.') } })
  assert.deepEqual(Object.keys(claim.snapshot.comments), ['11'])
  assert.deepEqual(Object.keys((await repaired.get(repository, 64))!.comments), ['11'])
})

test('authenticated outcome replies do not change a claim or wake a waiting PR', async t => {
  const inbox = new PullRequestInbox({ path: ':memory:', repositories: [repository], activityAuthors: [oldLogin], activityAppId: appId })
  t.onTestFinished(() => inbox.close())
  await inbox.seed(repository, pr)
  const claim = (await inbox.claim(1))[0]!
  const body = '<!-- vitehub-babysitter-repair:repair -->\n<!-- vitehub-babysitter-outcome:fixed -->\n**Fixed.**'
  const own = { ...comment(20, newLogin, appId, body), node_id: 'outcome-node' }
  const deliver = (id: string, item: ReturnType<typeof comment> = own) => inbox.ingest(id, 'pull_request_review_comment', {
    repository: { full_name: repository }, action: 'created', pull_request: pr, comment: item,
  })
  assert.deepEqual((await deliver('active-outcome')).updated, [])
  assert.equal((await inbox.get(repository, 64))?.generation, claim.generation)
  assert.deepEqual((await inbox.get(repository, 64))?.reviewComments, {})
  await inbox.finish(claim, { text: 'Waiting for checks.' })
  assert.deepEqual((await deliver('waiting-outcome')).queued, [])
  const observed = (await inbox.get(repository, 64))!
  assert.equal(await inbox.refreshThreads(observed, [{ id: 'thread', isResolved: true, comments: [own] }]), true)
  // The first observation of a resolved thread is evidence; a later own reply is not.
  const next = (await inbox.claim(1))[0]!
  assert.ok(next)
  await inbox.hydrate(next, { reviewComments: { 20: own }, threads: [{ id: 'thread', isResolved: true, comments: { nodes: [own] } }] })
  assert.deepEqual(next.snapshot.reviewComments, {})
  assert.deepEqual(next.snapshot.threads[0]?.comments, { nodes: [] })
  await inbox.finish(next, { text: 'Ready.' })
  assert.equal(await inbox.refreshThreads((await inbox.get(repository, 64))!, [{ id: 'thread', isResolved: true, comments: [{ id: 'outcome-node' }] }]), true)
  const threadReply = await inbox.ingest('thread-outcome', 'pull_request_review_thread', { repository: { full_name: repository }, action: 'resolved', pull_request: pr,
    thread: { node_id: 'thread', comments: [own] } })
  assert.deepEqual(threadReply.queued, [])
  assert.equal((await inbox.claim(1)).length, 0)
  assert.deepEqual((await deliver('foreign-marker', comment(21, oldLogin, 99, body))).queued, [64])
  assert.deepEqual((await deliver('real-review', comment(22, newLogin, appId, 'P1: this fails.'))).updated, [64])
})
