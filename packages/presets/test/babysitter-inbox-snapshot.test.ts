import { test } from 'vitest'
import assert from 'node:assert/strict'
import { PullRequestInbox } from '../src/babysitter/inbox/store.ts'
import { hydrateSnapshot, reconcileOneSnapshot, readForgePullRequestThreads } from '../src/babysitter/inbox/snapshot-sync.ts'
import { forgeProvider } from '@vite-hub/forge'
const repo = 'vite-hub/vitehub'
const pr = { number: 7, state: 'open', user: { login: 'onmax' }, head: { sha: 'a', ref: 'fix' }, base: { ref: 'main', sha: 'base' } }
const check = { id: 1, head_sha: 'a', name: 'ci', status: 'completed', conclusion: 'success' }
const read = async (path: string) => path.endsWith('/pulls/7') ? [pr] : path.includes('check-runs') ? [check] : []
test('claim hydration persists feedback/checks and reuses it on the same generation', async t => {
 const inbox = new PullRequestInbox({path: ':memory:', repositories: [repo]}); t.onTestFinished(() => inbox.close()); await inbox.seed(repo, pr)
 const claim = (await inbox.claim(1))[0]!; let calls = 0
 const fetch = async (path: string) => { calls++; return read(path) }
 assert.equal(await hydrateSnapshot(inbox, claim, fetch), true)
 assert.equal(claim.snapshot.checks['check_run:1']?.conclusion, 'success')
 assert.equal(calls, 6)
 await hydrateSnapshot(inbox, claim, fetch); assert.equal(calls, 6)
})
test('unknown mergeability rereads only the pull request', async t => {
 const inbox = new PullRequestInbox({path: ':memory:', repositories: [repo]}); t.onTestFinished(() => inbox.close()); await inbox.seed(repo, pr)
 const paths: string[] = []
 const fetch = async (path: string) => { paths.push(path); return path.endsWith('/pulls/7') ? [{ ...pr, mergeable: true, mergeable_state: 'blocked' }] : read(path) }
 const claim = (await inbox.claim(1))[0]!
 assert.equal(await hydrateSnapshot(inbox, claim, fetch), true)
 await inbox.finish(claim, { text: 'Waiting for CI' })
 await inbox.ingest('edited', 'pull_request', { repository: { full_name: repo }, action: 'edited', pull_request: { ...pr, title: 'Renamed', mergeable: null, mergeable_state: 'unknown' } })
 paths.length = 0
 const next = (await inbox.claim(1))[0]!
 assert.equal(next.snapshot.pr?.mergeable, null)
 assert.equal(await hydrateSnapshot(inbox, next, fetch), true)
 assert.deepEqual(paths, [`repos/${repo}/pulls/7`])
 assert.equal(next.snapshot.pr?.mergeable_state, 'blocked')
 assert.equal(next.snapshot.checks['check_run:1']?.conclusion, 'success')
})
test('new webhook during hydration wins over stale REST projection', async t => {
 const inbox = new PullRequestInbox({path: ':memory:', repositories: [repo]}); t.onTestFinished(() => inbox.close()); await inbox.seed(repo, pr)
 const claim = (await inbox.claim(1))[0]!
 const fetch = async (path: string) => {
  if (path.endsWith('/pulls/7')) await inbox.ingest('new-head', 'pull_request', { repository: { full_name: repo }, action: 'synchronize', pull_request: { ...pr, head: { sha: 'b', ref: 'fix' } } })
  return read(path)
 }
 assert.equal(await hydrateSnapshot(inbox, claim, fetch), false)
 assert.equal((await inbox.get(repo, 7))?.pr?.head?.sha, 'b')
 await inbox.release(claim); assert.equal((await inbox.claim(1))[0]?.snapshot.pr?.head?.sha, 'b')
})
test('missed completed check wakes waiting generation, unchanged recovery does not', async t => {
 let now = 1000
 const inbox = new PullRequestInbox({path: ':memory:', repositories: [repo], clock: () => now}); t.onTestFinished(() => inbox.close()); await inbox.seed(repo, pr)
 await inbox.finish((await inbox.claim(1))[0]!, { text: 'Waiting for CI' })
 await reconcileOneSnapshot(inbox, read, now)
 assert.equal((await inbox.claim(1)).length, 0)
 now += 15 * 60_000
 await reconcileOneSnapshot(inbox, read, now)
 const claim = (await inbox.claim(1))[0]!; assert.ok(claim)
 await inbox.finish(claim, { text: 'Inspected completed CI' })
 now += 15 * 60_000
 await reconcileOneSnapshot(inbox, read, now)
 assert.equal((await inbox.claim(1)).length, 0)
})

test('thread hydration caches known resolution and reuses it without any GitHub read', async t => {
 const inbox = new PullRequestInbox({path: ':memory:', repositories: [repo]}); t.onTestFinished(() => inbox.close()); await inbox.seed(repo, pr)
 const claim = (await inbox.claim(1))[0]!; let restCalls = 0; let threadCalls = 0
 const fetch = async (path: string) => { restCalls++; return read(path) }
 const threads = async () => { threadCalls++; return [{ id: 'PRRT_1', isResolved: false, comments: [{ databaseId: 1 }] }] }
 assert.equal(await hydrateSnapshot(inbox, claim, fetch, threads), true)
 assert.equal(claim.snapshot.threadsHydrated, true); assert.equal(claim.snapshot.threads[0]?.isResolved, false)
 assert.equal(await hydrateSnapshot(inbox, claim, fetch, threads), true)
 assert.equal(restCalls, 6); assert.equal(threadCalls, 1)
 await inbox.finish(claim, { text: 'wait' })
 await inbox.ingest('review-comment', 'pull_request_review_comment', { repository: { full_name: repo }, action: 'created', pull_request: pr, comment: { id: 1, body: 'repair', user: { login: 'human' } } })
 assert.equal(await hydrateSnapshot(inbox, (await inbox.claim(1))[0]!, fetch, threads), true)
 assert.equal(restCalls, 6); assert.equal(threadCalls, 2)
})
test('thread hydration error defers instead of claiming resolution is known', async t => {
 const inbox = new PullRequestInbox({path: ':memory:', repositories: [repo]}); t.onTestFinished(() => inbox.close()); await inbox.seed(repo, pr)
 const claim = (await inbox.claim(1))[0]!
 await assert.rejects(hydrateSnapshot(inbox, claim, read, async () => { throw new Error('rate limit') }), /rate limit/)
 assert.equal((await inbox.get(repo, 7))?.threadsHydrated, undefined)
 assert.equal((await inbox.get(repo, 7))?.hydrated, false)
})
test('forge thread reader preserves identities after the upstream 100-comment limit', async () => {
 const calls: Array<{ query: string; variables: Record<string, unknown> }> = []
 const first = Array.from({ length: 100 }, (_, i) => ({ id: `c${i + 1}`, databaseId: i + 1 }))
 const provider = await forgeProvider({ forge: 'github', token: 'token', fetch: async (input, init) => {
  const call = await new Request(input, init).json() as typeof calls[number]
  calls.push(call)
  if (call.query.includes('ReviewThreadPage')) return Response.json({ data: { repository: { pullRequest: { reviewThreads: {
   nodes: [{ id: 't1', isResolved: false, isOutdated: false, comments: { nodes: first } }],
   pageInfo: { hasNextPage: false, endCursor: null },
  } } } } })
  assert.equal(call.variables.id, 't1')
  const more = call.variables.after === 'comment-next'
  return Response.json({ data: { node: { comments: {
   nodes: more ? [{ id: 'human', databaseId: 101 }] : first,
   pageInfo: { hasNextPage: !more, endCursor: more ? null : 'comment-next' },
  } } } })
 } })
 const threads = await readForgePullRequestThreads(provider, repo, 7)
 assert.ok(Array.isArray(threads[0]?.comments))
 assert.equal(threads[0].comments.length, 101)
 assert.deepEqual(threads[0].comments.at(-1), { id: 'human', databaseId: 101 })
 assert.equal(calls.length, 3)
 assert.equal(calls[2]?.variables.after, 'comment-next')
})

test('forge thread reader rejects incomplete comment reads', async () => {
 for (const [response, error] of [
  [{ data: { node: { comments: { nodes: [] } } } }, /pageInfo/],
  [{ errors: [{ message: 'quota exceeded' }], data: { node: null } }, /quota exceeded/],
  [{ data: { node: { comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } } }, /pagination cursor/],
 ] as const) {
  const provider = await forgeProvider({ forge: 'github', token: 'token', fetch: async (input, init) => {
   const { query } = await new Request(input, init).json() as { query: string }
   if (!query.includes('ReviewThreadPage')) return Response.json(response)
   return Response.json({ data: { repository: { pullRequest: { reviewThreads: {
    nodes: [{ id: 't1', isResolved: false, comments: { nodes: Array.from({ length: 100 }, (_, i) => ({ databaseId: i + 1 })) } }],
    pageInfo: { hasNextPage: false, endCursor: null },
   } } } } })
  } })
  await assert.rejects(readForgePullRequestThreads(provider, repo, 7), error)
 }
})

test('changed resolution webhook requests one targeted verification because deliveries can arrive out of order', async t => {
 const inbox = new PullRequestInbox({path: ':memory:', repositories: [repo]}); t.onTestFinished(() => inbox.close()); await inbox.seed(repo, pr)
 const claim = (await inbox.claim(1))[0]!; let threadCalls = 0
 const threads = async () => { threadCalls++; return [{ id: 'thread', isResolved: false, comments: [] }] }
 await hydrateSnapshot(inbox, claim, read, threads)
 await inbox.finish(claim, { text: 'wait' })
 await inbox.ingest('late-resolved', 'pull_request_review_thread', { repository: { full_name: repo }, action: 'resolved', pull_request: pr, thread: { node_id: 'thread', comments: [] } })
 assert.equal((await inbox.get(repo, 7))?.feedbackRefresh, true)
 assert.equal((await inbox.get(repo, 7))?.threads[0]?.isResolved, true)
 const next = (await inbox.claim(1))[0]!
 await hydrateSnapshot(inbox, next, async () => { throw new Error('Must not reread REST for a thread-only change') }, threads)
 assert.equal(threadCalls, 2)
 assert.equal(next.snapshot.threads[0]?.isResolved, false)
 assert.equal(next.snapshot.feedbackRefresh, false)
})

test('REST hydration preserves all reviewer bots and maps full inline text to explicit thread state', async t => {
 const inbox = new PullRequestInbox({path: ':memory:', repositories: [repo]}); t.onTestFinished(() => inbox.close()); await inbox.seed(repo, pr)
 const user = { login: 'future-reviewer-bot[bot]', type: 'Bot' }
 const fetch = async (path: string) => {
  if (/(?:^|\/)repos\/vite-hub\/vitehub\/pulls\/7\/reviews\?per_page=100(?:&|$)/.test(path)) return [{ id: 8, user, state: 'CHANGES_REQUESTED', body: 'Entire reviewer body' }]
  if (path.includes('/pulls/7/comments')) return [{ id: 9, node_id: 'inline-node', user, body: 'Entire inline finding' }]
  return read(path)
 }
 const claim = (await inbox.claim(1))[0]!
 await hydrateSnapshot(inbox, claim, fetch, async () => [{ id: 'thread', isResolved: false, comments: [{ id: 'inline-node', databaseId: 9 }] }])
 assert.equal(claim.snapshot.reviews['8']?.body, 'Entire reviewer body')
 assert.equal(claim.snapshot.reviewComments['9']?.body, 'Entire inline finding')
 assert.ok(Array.isArray(claim.snapshot.threads[0]?.comments)); assert.equal(claim.snapshot.threads[0].comments[0]?.databaseId, 9)
 assert.equal(claim.snapshot.threads[0]?.isResolved, false)
})

test('reconcile keeps review and comment delivery IDs when only the embedded PR changed', async t => {
 let now = 1000
 const inbox = new PullRequestInbox({path: ':memory:', repositories: [repo], clock: () => now}); t.onTestFinished(() => inbox.close()); await inbox.seed(repo, pr)
 let current = { ...pr, updated_at: '2026-11-01T00:00:00Z', mergeable_state: 'clean' }
 const review = { id: 9, state: 'COMMENTED', body: 'nit', user: { login: 'human' }, commit_id: 'a' }
 const comment = { id: 5, body: 'repair', user: { login: 'human' }, path: 'a.ts' }
 const fetch = async (path: string) => path.endsWith('/pulls/7') ? [current] : path.includes('/reviews') ? [review] : path.includes('/pulls/7/comments') ? [comment] : read(path)
 const stored: string[] = []
 const ingest = inbox.ingest.bind(inbox)
 inbox.ingest = async (id, event, value) => { const result = await ingest(id, event, value); if (!result.duplicate && event !== 'pull_request') stored.push(event); return result }
 await reconcileOneSnapshot(inbox, fetch, now)
 now += 15 * 60_000; await reconcileOneSnapshot(inbox, fetch, now)
 const first = stored.length
 assert.ok(first >= 2)
 current = { ...current, updated_at: '2026-11-01T00:15:00Z', mergeable_state: 'blocked' }
 now += 15 * 60_000; await reconcileOneSnapshot(inbox, fetch, now)
 assert.equal(stored.length, first)
 current = { ...current, head: { sha: 'b', ref: 'fix' } }
 now += 15 * 60_000; await reconcileOneSnapshot(inbox, fetch, now)
 assert.ok(stored.length > first)
})
