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
