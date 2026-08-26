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

test('waits for Codex and Pullfrog to finish before merging', async () => {
  const prompt = await readFile(new URL('../server/agents/babysitter/prompt.template.md', import.meta.url), 'utf8')

  assert.match(prompt, /If no exact-head `@codex review` request exists, post one and stop/)
  assert.match(prompt, /While a Codex `eyes` reaction is the latest result, stop unchanged/)
  assert.match(prompt, /If Pullfrog appears on the pull request, its latest linked workflow run completed successfully and it submitted a review for the expected head/)
  assert.match(prompt, /While the run is queued or running, stop unchanged/)
  assert.match(prompt, /A failed or cancelled run, or a review for another head, blocks the merge/)
})

test('returns a machine-readable completion disposition', async () => {
  const prompt = await readFile(new URL('../server/agents/babysitter/prompt.template.md', import.meta.url), 'utf8')

  assert.match(prompt, /<!-- babysitter:disposition:park -->/)
  assert.match(prompt, /<!-- babysitter:disposition:retry -->/)
  assert.match(prompt, /failed check remains unfixed/)
})
