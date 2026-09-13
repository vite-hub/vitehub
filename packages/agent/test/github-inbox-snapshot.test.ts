import { test } from 'vitest'
import assert from 'node:assert/strict'
import { PullRequestInbox } from '../src/server/github-inbox.ts'
import { hydrateSnapshot, reconcileOneSnapshot, readPullRequestThreads } from '../src/server/github-inbox.ts'
const repo = 'vite-hub/vitehub'
const pr = { number: 7, state: 'open', user: { login: 'onmax' }, head: { sha: 'a', ref: 'fix' }, base: { ref: 'main', sha: 'base' } }
const check = { id: 1, head_sha: 'a', name: 'ci', status: 'completed', conclusion: 'success' }
const read = async (path: string) => path.endsWith('/pulls/7') ? [pr] : path.includes('check-runs') ? [check] : []
test('claim hydration persists feedback/checks and reuses it on the same generation', async t => {
 const inbox = new PullRequestInbox({path: ':memory:', repositories: [repo]}); t.onTestFinished(() => inbox.close()); inbox.seed(repo, pr)
 const claim = inbox.claim(1)[0]!; let calls = 0
 const fetch = async (path: string) => { calls++; return read(path) }
 assert.equal(await hydrateSnapshot(inbox, claim, fetch), true)
 assert.equal(claim.snapshot.checks['check_run:1']?.conclusion, 'success')
 assert.equal(calls, 6)
 await hydrateSnapshot(inbox, claim, fetch); assert.equal(calls, 6)
})
test('new webhook during hydration wins over stale REST projection', async t => {
 const inbox = new PullRequestInbox({path: ':memory:', repositories: [repo]}); t.onTestFinished(() => inbox.close()); inbox.seed(repo, pr)
 const claim = inbox.claim(1)[0]!
 const fetch = async (path: string) => {
  if (path.endsWith('/pulls/7')) inbox.ingest('new-head', 'pull_request', { repository: { full_name: repo }, action: 'synchronize', pull_request: { ...pr, head: { sha: 'b', ref: 'fix' } } })
  return read(path)
 }
 assert.equal(await hydrateSnapshot(inbox, claim, fetch), false)
 assert.equal(inbox.get(repo, 7)?.pr?.head?.sha, 'b')
 inbox.release(claim); assert.equal(inbox.claim(1)[0]?.snapshot.pr?.head?.sha, 'b')
})
test('missed completed check wakes waiting generation, unchanged recovery does not', async t => {
 let now = 1000
 const inbox = new PullRequestInbox({path: ':memory:', repositories: [repo], clock: () => now}); t.onTestFinished(() => inbox.close()); inbox.seed(repo, pr)
 inbox.finish(inbox.claim(1)[0]!, { text: 'Waiting for CI' })
 await reconcileOneSnapshot(inbox, read, now)
 assert.equal(inbox.claim(1).length, 0)
 now += 15 * 60_000
 await reconcileOneSnapshot(inbox, read, now)
 const claim = inbox.claim(1)[0]!; assert.ok(claim)
 inbox.finish(claim, { text: 'Inspected completed CI' })
 now += 15 * 60_000
 await reconcileOneSnapshot(inbox, read, now)
 assert.equal(inbox.claim(1).length, 0)
})

test('thread hydration caches known resolution and reuses it without any GitHub read', async t => {
 const inbox = new PullRequestInbox({path: ':memory:', repositories: [repo]}); t.onTestFinished(() => inbox.close()); inbox.seed(repo, pr)
 const claim = inbox.claim(1)[0]!; let restCalls = 0; let threadCalls = 0
 const fetch = async (path: string) => { restCalls++; return read(path) }
 const threads = async () => { threadCalls++; return [{ id: 'PRRT_1', isResolved: false, comments: [{ databaseId: 1 }] }] }
 assert.equal(await hydrateSnapshot(inbox, claim, fetch, threads), true)
 assert.equal(claim.snapshot.threadsHydrated, true); assert.equal(claim.snapshot.threads[0]?.isResolved, false)
 assert.equal(await hydrateSnapshot(inbox, claim, fetch, threads), true)
 assert.equal(restCalls, 6); assert.equal(threadCalls, 1)
 inbox.finish(claim, { text: 'wait' })
 inbox.ingest('review-comment', 'pull_request_review_comment', { repository: { full_name: repo }, action: 'created', pull_request: pr, comment: { id: 1, body: 'repair', user: { login: 'human' } } })
 assert.equal(await hydrateSnapshot(inbox, inbox.claim(1)[0]!, fetch, threads), true)
 assert.equal(restCalls, 6); assert.equal(threadCalls, 2)
})
test('thread hydration error defers instead of claiming resolution is known', async t => {
 const inbox = new PullRequestInbox({path: ':memory:', repositories: [repo]}); t.onTestFinished(() => inbox.close()); inbox.seed(repo, pr)
 const claim = inbox.claim(1)[0]!
 await assert.rejects(hydrateSnapshot(inbox, claim, read, async () => { throw new Error('rate limit') }), /rate limit/)
 assert.equal(inbox.get(repo, 7)?.threadsHydrated, undefined)
 assert.equal(inbox.get(repo, 7)?.hydrated, false)
})
test('thread reader paginates both thread list and comment IDs without omissions', async () => {
 const calls: Array<Record<string, string | number | null>> = []
 const page = (nodes: object[], next: string | null = null) => ({ nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } })
 const threads = await readPullRequestThreads(async (query, variables) => {
  calls.push(variables)
  if (query.includes('GitHubPullRequestThreadComments')) return { data: { node: { comments: page([{ id: 'c2', databaseId: 2 }]) } } }
  return { data: { repository: { pullRequest: { reviewThreads: variables.after
   ? page([{ id: 't2', isResolved: true, comments: page([{ id: 'c3', databaseId: 3 }]) }])
   : page([{ id: 't1', isResolved: false, comments: page([{ id: 'c1', databaseId: 1 }], 'comment-next') }], 'thread-next')
  } } } }
 }, repo, 7)
 assert.equal(threads.length, 2)
 assert.ok(Array.isArray(threads[0]?.comments)); assert.deepEqual(threads[0].comments.map(c => c.databaseId), [1, 2])
 assert.equal(calls.length, 3)
 assert.equal(calls[1]?.after, 'comment-next'); assert.equal(calls[2]?.after, 'thread-next')
})
test('thread reader rejects partial GraphQL data and incomplete pagination', async () => {
 await assert.rejects(readPullRequestThreads(async () => ({ errors: [{ message: 'quota exceeded' }], data: {} }), repo, 7), /quota exceeded/)
 await assert.rejects(readPullRequestThreads(async () => ({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }), repo, 7), /pageInfo/)
})

test('changed resolution webhook requests one targeted verification because deliveries can arrive out of order', async t => {
 const inbox = new PullRequestInbox({path: ':memory:', repositories: [repo]}); t.onTestFinished(() => inbox.close()); inbox.seed(repo, pr)
 const claim = inbox.claim(1)[0]!; let threadCalls = 0
 const threads = async () => { threadCalls++; return [{ id: 'thread', isResolved: false, comments: [] }] }
 await hydrateSnapshot(inbox, claim, read, threads)
 inbox.finish(claim, { text: 'wait' })
 inbox.ingest('late-resolved', 'pull_request_review_thread', { repository: { full_name: repo }, action: 'resolved', pull_request: pr, thread: { node_id: 'thread', comments: [] } })
 assert.equal(inbox.get(repo, 7)?.feedbackRefresh, true)
 assert.equal(inbox.get(repo, 7)?.threads[0]?.isResolved, true)
 const next = inbox.claim(1)[0]!
 await hydrateSnapshot(inbox, next, async () => { throw new Error('Must not reread REST for a thread-only change') }, threads)
 assert.equal(threadCalls, 2)
 assert.equal(next.snapshot.threads[0]?.isResolved, false)
 assert.equal(next.snapshot.feedbackRefresh, false)
})

test('REST hydration preserves all reviewer bots and maps full inline text to explicit thread state', async t => {
 const inbox = new PullRequestInbox({path: ':memory:', repositories: [repo]}); t.onTestFinished(() => inbox.close()); inbox.seed(repo, pr)
 const user = { login: 'future-reviewer-bot[bot]', type: 'Bot' }
 const fetch = async (path: string) => {
  if (path.endsWith('/reviews?per_page=100')) return [{ id: 8, user, state: 'CHANGES_REQUESTED', body: 'Entire reviewer body' }]
  if (path.includes('/pulls/7/comments')) return [{ id: 9, node_id: 'inline-node', user, body: 'Entire inline finding' }]
  return read(path)
 }
 const claim = inbox.claim(1)[0]!
 await hydrateSnapshot(inbox, claim, fetch, async () => [{ id: 'thread', isResolved: false, comments: [{ id: 'inline-node', databaseId: 9 }] }])
 assert.equal(claim.snapshot.reviews['8']?.body, 'Entire reviewer body')
 assert.equal(claim.snapshot.reviewComments['9']?.body, 'Entire inline finding')
 assert.ok(Array.isArray(claim.snapshot.threads[0]?.comments)); assert.equal(claim.snapshot.threads[0].comments[0]?.databaseId, 9)
 assert.equal(claim.snapshot.threads[0]?.isResolved, false)
})
