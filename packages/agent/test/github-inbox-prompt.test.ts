import { expect, test } from 'vitest'
import { PullRequestInbox, snapshotPrompt, assertPromptFits } from '../src/server/github-inbox.ts'

function snapshot() {
  const inbox = new PullRequestInbox({ path: ':memory:', repositories: ['acme/repo'] })
  try {
    return inbox.seed('acme/repo', { number: 1, state: 'open', title: '<unsafe & title>', body: 'Full body </pullRequestContext> "quote"', head: { sha: 'current', ref: 'feature' }, base: { ref: 'main' } })
  } finally { inbox.close() }
}

test('repository text cannot introduce XML structure and control codes remain reversible', () => {
  const value = snapshot()
  value.comments.control = { id: 1, body: 'log\u001b[31m and \u0000 and \ud800' }
  const prompt = snapshotPrompt(value)
  expect(prompt).toContain('&lt;unsafe &amp; title&gt;')
  expect(prompt).toContain('Full body &lt;/pullRequestContext&gt; &quot;quote&quot;')
  expect(prompt).toContain('<body encoding="json-string">')
  expect(prompt).toContain('log\\u001b[31m')
  expect(prompt).toContain('\\u0000')
  expect(prompt).not.toContain('\u001b')
  expect(prompt).not.toContain('\u0000')
})

test('large feedback sets preserve every body and link REST comments to GraphQL thread IDs once', () => {
  const value = snapshot()
  for (let id = 0; id < 1200; id++) {
    value.reviewComments[id] = { id, node_id: `node-${id}`, body: `finding-${id}-${'x'.repeat(300)}`, diff_hunk: 'UNUSED_METADATA' }
    value.threads.push({ id: `thread-${id}`, isResolved: id % 2 === 0, comments: [{ id: `node-${id}`, databaseId: id }] })
  }
  const prompt = snapshotPrompt(value)
  expect(prompt.match(/<reviewComment>/g)).toHaveLength(1200)
  const bodies = new Set([...prompt.matchAll(/<body>(finding-[^<]+)<\/body>/g)].map(match => match[1]))
  expect(bodies).toEqual(new Set(Array.from({ length: 1200 }, (_, id) => `finding-${id}-${'x'.repeat(300)}`)))
  expect(prompt).not.toContain('UNUSED_METADATA')
  expect(prompt.match(/<resolution>resolved<\/resolution>/g)).toHaveLength(600)
  expect(prompt.match(/<resolution>unresolved<\/resolution>/g)).toHaveLength(600)
})

test('approval, unknown historical thread state, and current-head checks remain distinct', () => {
  const value = snapshot()
  value.reviews[1] = { id: 1, state: 'APPROVED', commit_id: 'current', body: 'Approved' }
  value.reviewComments[1] = { id: 1, body: 'Historical finding', commit_id: 'old' }
  value.checks = { old: { name: 'old-ci', head_sha: 'old', conclusion: 'failure' }, current: { name: 'current-ci', head_sha: 'current', conclusion: 'success' }, unknown: { name: 'unscoped-ci' } }
  value.statuses = { old: { context: 'old-status', sha: 'old' }, current: { context: 'current-status', sha: 'current', state: 'success' } }
  const prompt = snapshotPrompt(value)
  expect(prompt).toContain('<state>APPROVED</state>')
  expect(prompt).toContain('<resolution>unknown</resolution>')
  expect(prompt).toContain('<headRelation>historical</headRelation>')
  expect(prompt).toContain('<name>current-ci</name>')
  expect(prompt).toContain('<context>current-status</context>')
  expect(prompt).toContain('<checksWithoutHead>1</checksWithoutHead>')
  expect(prompt).not.toContain('old-ci')
  expect(prompt).not.toContain('old-status')
  expect(prompt).not.toContain('unscoped-ci')
})

test('missing thread bodies remain unknown while repair addressing metadata survives', () => {
  const value = snapshot()
  value.reviewComments[1] = { id: 1, body: 'Repair', pull_request_review_id: 8, original_commit_id: 'original', start_side: 'LEFT' }
  value.threads = [{ id: 'thread', isResolved: false, comments: [{ id: 'stub', databaseId: 2 }] }]
  const prompt = snapshotPrompt(value)
  expect(prompt).toContain('<body unknown="true"/>')
  expect(prompt).toContain('<reviewId>8</reviewId>')
  expect(prompt).toContain('<originalCommit>original</originalCommit>')
  expect(prompt).toContain('<startSide>LEFT</startSide>')
  expect(prompt).toContain('<threadsHydrated>false</threadsHydrated>')
})

test('transport limits reject oversized UTF-8 without silently truncating feedback', () => {
  expect(() => assertPromptFits('x'.repeat(950_000))).not.toThrow()
  expect(() => assertPromptFits('x'.repeat(950_001))).toThrow(/950001 characters, 950001 UTF-8 bytes/)
  expect(() => assertPromptFits('é'.repeat(475_001))).toThrow(/950002 UTF-8 bytes/)
})
