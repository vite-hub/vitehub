import { test } from 'vitest'
import assert from 'node:assert/strict'
import { PullRequestInbox } from '../src/server/github-inbox.ts'
import { snapshotPullRequest, claimStopReason, createClaimStopCheck } from '../src/server/github-inbox.ts'

function fixture() {
  const inbox = new PullRequestInbox({path: ':memory:', repositories: ['vite-hub/vitehub']})
  inbox.seed('vite-hub/vitehub', { number: 42, state: 'open', user: { login: 'onmax' }, head: { sha: 'new', ref: 'feature', repo: { full_name: 'vite-hub/vitehub' } }, base: { sha: 'base', ref: 'main' }, headRefOid: 'stale', headRefName: 'stale-branch', title: 'Test', html_url: 'https://github.com/vite-hub/vitehub/pull/42', updated_at: '2026-09-13T00:00:00Z' })
  return inbox
}

test('REST webhook head overrides persisted stale GraphQL aliases for checkout', () => {
  const inbox = fixture()
  try {
    const claim = inbox.claim(1)[0]!
    assert.ok(claim)
    const pr = snapshotPullRequest(claim.snapshot)
    assert.equal(pr.headRefOid, 'new')
    assert.equal(pr.headRefName, 'feature')
    assert.equal(pr.state, 'OPEN')
    assert.equal(pr.url, 'https://github.com/vite-hub/vitehub/pull/42')
  } finally { inbox.close() }
})

test('same-head feedback leaves active pass running; new head cancels without network polling', () => {
  const inbox = fixture()
  try {
    const claim = inbox.claim(1)[0]!
    const current = structuredClone(claim.snapshot)
    current.generation++
    assert.equal(claimStopReason(claim, current), undefined)
    current.pr!.head!.sha = 'newer'
    assert.equal(claimStopReason(claim, current), 'Pull request head changed.')
  } finally { inbox.close() }
})

test('terminal webhook and lost lease cancel active pass', () => {
  const inbox = fixture()
  try {
    const claim = inbox.claim(1)[0]!
    const current = structuredClone(claim.snapshot)
    current.status = 'terminal'
    assert.equal(claimStopReason(claim, current), 'Pull request is no longer open.')
    current.lease = 'another-owner'
    assert.equal(claimStopReason(claim, current), 'Pull request lease lost.')
  } finally { inbox.close() }
})

test('new generation remains claimable after old pass parks, without second completion gate', () => {
  const inbox = fixture()
  try {
    const old = inbox.claim(1)[0]!
    inbox.ingest('comment', 'issue_comment', { repository: { full_name: 'vite-hub/vitehub' }, issue: { number: 42, pull_request: {} }, action: 'created', comment: { id: 1, body: 'Please fix test', user: { login: 'onmax', type: 'User' } } })
    inbox.finish(old, { text: 'Waiting for checks' })
    const next = inbox.claim(1)[0]!
    assert.ok(next)
    assert.ok(next.generation > old.generation)
    assert.equal(next.snapshot.comments['1']!.body, 'Please fix test')
  } finally { inbox.close() }
})

test('own repair head proven from provider Git survives cleanup; external head still cancels', async () => {
 const inbox = fixture()
 try {
  const claim = inbox.claim(1)[0]!
  const current = structuredClone(claim.snapshot)
  let reads = 0, cleanup = false
  const check = createClaimStopCheck(claim, () => current, async () => { reads++; if (cleanup) throw new Error('provider directory removed'); return 'repair' })
  assert.equal(await check(), undefined)
  assert.equal(reads, 0)
  current.pr!.head!.sha = 'repair'
  assert.equal(await check(), undefined)
  assert.equal(reads, 1)
  cleanup = true
  assert.equal(await check(), undefined)
  assert.equal(reads, 1)
  current.pr!.head!.sha = 'external'
  assert.equal(await check(), 'Pull request head changed.')
  assert.equal(reads, 2)
 } finally { inbox.close() }
})

test('head change without a provider HEAD match cancels regardless of bot identity', async () => {
 const inbox = fixture()
 try {
  const claim = inbox.claim(1)[0]!, current = structuredClone(claim.snapshot)
  current.pr!.head!.sha = 'external'; current.pr!.user = { login: 'vitehub-bot' }
  for (const providerHead of [undefined, 'different']) {
   const check = createClaimStopCheck(claim, () => current, async () => providerHead)
   assert.equal(await check(), 'Pull request head changed.')
  }
  const failed = createClaimStopCheck(claim, () => current, async () => { throw new Error('git failed') })
  assert.equal(await failed(), 'Pull request head changed.')
 } finally { inbox.close() }
})

test('closed PR and lease loss win even after a verified repair push', async () => {
 const inbox = fixture()
 try {
  const claim = inbox.claim(1)[0]!, current = structuredClone(claim.snapshot)
  current.pr!.head!.sha = 'repair'
  const check = createClaimStopCheck(claim, () => current, async () => 'repair')
  assert.equal(await check(), undefined)
  current.status = 'terminal'
  assert.equal(await check(), 'Pull request is no longer open.')
  current.status = 'working'; current.lease = 'different'
  assert.equal(await check(), 'Pull request lease lost.')
 } finally { inbox.close() }
})

test('new remote event during provider HEAD read is rechecked before accepting proof', async () => {
 const inbox = fixture()
 try {
  const claim = inbox.claim(1)[0]!, current = structuredClone(claim.snapshot)
  current.pr!.head!.sha = 'repair'
  const check = createClaimStopCheck(claim, () => current, async () => { current.pr!.head!.sha = 'external'; return 'repair' })
  assert.equal(await check(), 'Pull request head changed.')
 } finally { inbox.close() }
})
