import assert from 'node:assert/strict'
import { test } from 'vitest'
import { PullRequestInbox } from '../src/babysitter/inbox/store.ts'

const repository = 'vite-hub/vitehub'
const pullRequest = (head: string, updatedAt: string) => ({
  number: 7,
  state: 'open',
  user: { login: 'onmax' },
  head: { sha: head, ref: 'fix' },
  base: { sha: 'base', ref: 'main' },
  updated_at: updatedAt,
})

test('GitHub synchronize before/after fields advance the durable head and reject late CI', async t => {
  const inbox = new PullRequestInbox({ path: ':memory:', repositories: [repository] })
  t.onTestFinished(() => inbox.close())
  await inbox.seed(repository, pullRequest('old', '2026-10-13T08:00:00Z'))
  await inbox.ingest('old-ci', 'check_run', {
    repository: { full_name: repository },
    check_run: { id: 1, head_sha: 'old', conclusion: 'failure' },
  })
  const result = await inbox.ingest('sync', 'pull_request', {
    repository: { full_name: repository },
    action: 'synchronize',
    number: 7,
    before: 'old',
    after: 'new',
    pull_request: pullRequest('new', '2026-10-13T08:01:00Z'),
  })
  assert.deepEqual(result.updated, [7])
  const current = await inbox.get(repository, 7)
  assert.equal(current?.pr?.head?.sha, 'new')
  assert.deepEqual(current?.checks, {})
  const late = await inbox.ingest('late-ci', 'check_run', {
    repository: { full_name: repository },
    check_run: { id: 1, head_sha: 'old', pull_requests: [{ number: 7 }], conclusion: 'failure' },
  })
  assert.deepEqual(late.updated, [])
  assert.equal((await inbox.get(repository, 7))?.generation, current?.generation)
})

test('a synchronize delivery with after fences an active old-head claim', async t => {
  const inbox = new PullRequestInbox({ path: ':memory:', repositories: [repository] })
  t.onTestFinished(() => inbox.close())
  await inbox.seed(repository, pullRequest('old', '2026-10-13T08:00:00Z'))
  const [claim] = await inbox.claim(1)
  assert.ok(claim)
  await inbox.ingest('sync', 'pull_request', {
    repository: { full_name: repository },
    action: 'synchronize',
    before: 'old',
    after: 'new',
    pull_request: pullRequest('new', '2026-10-13T08:01:00Z'),
  })
  assert.equal(await inbox.renew(claim, Date.now() + 60_000), false)
  await inbox.finish(claim, { text: 'old claim cancelled' })
  const [next] = await inbox.claim(1)
  assert.equal(next?.snapshot.pr?.head?.sha, 'new')
})

test('base branch pushes still wake their open children with a different after SHA', async t => {
  const inbox = new PullRequestInbox({ path: ':memory:', repositories: [repository] })
  t.onTestFinished(() => inbox.close())
  await inbox.seed(repository, pullRequest('head', '2026-10-13T08:00:00Z'))
  const [claim] = await inbox.claim(1)
  assert.ok(claim)
  await inbox.finish(claim, { text: 'ready' })
  const result = await inbox.ingest('push', 'push', {
    repository: { full_name: repository },
    ref: 'refs/heads/main',
    before: 'base',
    after: 'new-base',
  })
  assert.deepEqual(result.queued, [7])
  assert.equal((await inbox.get(repository, 7))?.pr?.head?.sha, 'head')
})
