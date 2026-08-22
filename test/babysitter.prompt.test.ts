import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('preserves open child pull requests before merging a stacked base', async () => {
  const prompt = await readFile(new URL('../server/agents/babysitter/prompt.template.md', import.meta.url), 'utf8')
  const preserveChildren = prompt.indexOf('Retarget every open child pull request to this pull request\'s base branch')
  const merge = prompt.indexOf('When the gate holds, squash through GitHub\'s merge API')

  assert.notEqual(preserveChildren, -1)
  assert.notEqual(merge, -1)
  assert.ok(preserveChildren < merge)
})

test('ends a repair pass after one commit, push, and review request', async () => {
  const prompt = await readFile(new URL('../server/agents/babysitter/prompt.template.md', import.meta.url), 'utf8')

  assert.match(prompt, /for one pass, then stop/)
  assert.match(prompt, /at most one new commit/)
  assert.match(prompt, /push once/)
  assert.match(prompt, /request one `@codex review`/)
  assert.match(prompt, /Stop after the review request/)
  assert.doesNotMatch(prompt, /repeat until the merge gate holds/)
})

test('yields pending checks and reviews to the next schedule', async () => {
  const prompt = await readFile(new URL('../server/agents/babysitter/prompt.template.md', import.meta.url), 'utf8')

  assert.match(prompt, /checks or reviews are pending/)
  assert.match(prompt, /stop unchanged/)
  assert.match(prompt, /GitHub state change wakes the next pass/)
})
