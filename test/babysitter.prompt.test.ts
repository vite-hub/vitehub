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

  assert.match(prompt, /Create at most one new repair commit/)
  assert.match(prompt, /push once/)
  assert.match(prompt, /request one `@codex review`/)
  assert.match(prompt, /finish the pass immediately/)
  assert.doesNotMatch(prompt, /repeat until the merge gate holds/)
})

test('yields pending checks and reviews to the next schedule', async () => {
  const prompt = await readFile(new URL('../server/agents/babysitter/prompt.template.md', import.meta.url), 'utf8')

  assert.match(prompt, /checks or reviews are pending/)
  assert.match(prompt, /finish unchanged/)
  assert.match(prompt, /scheduler will wake this pull request when its observed GitHub state changes/)
})
