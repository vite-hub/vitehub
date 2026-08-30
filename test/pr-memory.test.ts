import assert from 'node:assert/strict'
import test from 'node:test'
import { appendPRMemory, prMemoryKey, readPRMemory, renderPRMemory } from '../server/pr-memory.ts'

function memoryStorage() {
  const values = new Map<string, unknown>()
  return {
    async get<T>(key: string) {
      return [undefined, values.get(key) as T | undefined] as const
    },
    async set<T>(key: string, value: T) {
      values.set(key, value)
      return [undefined] as const
    },
    values,
  }
}

test('appends detailed sourced findings to one pull request memory', async () => {
  const storage = memoryStorage()
  const context = {
    head: '0123456789012345678901234567890123456789',
    invocationId: 'run-1',
    pullRequest: 42,
    repository: 'vite-hub/example',
  }
  await appendPRMemory(context, { items: [{
    content: 'Cleanup belongs to the provider lifecycle because it owns the abort signal.\n\nThis affects finish hooks and terminal reporting.',
    sources: ['https://github.com/vite-hub/example/pull/42#discussion_r123'],
  }] }, storage as never, () => '2026-08-30T12:00:00.000Z')

  const memory = await readPRMemory(context.repository, context.pullRequest, storage as never)
  assert.equal(memory.items.length, 1)
  assert.deepEqual(memory.items[0], {
    content: 'Cleanup belongs to the provider lifecycle because it owns the abort signal.\n\nThis affects finish hooks and terminal reporting.',
    createdAt: '2026-08-30T12:00:00.000Z',
    head: context.head,
    invocationId: context.invocationId,
    sources: ['https://github.com/vite-hub/example/pull/42#discussion_r123'],
  })
  assert.equal(storage.values.has(prMemoryKey(context.repository, context.pullRequest)), true)
})

test('renders the append-only memory as a sourced Markdown artifact', () => {
  const content = renderPRMemory({
    items: [{
      content: 'A durable finding.\n\nIts reason and effect.',
      createdAt: '2026-08-30T12:00:00.000Z',
      head: '0123456789012345678901234567890123456789',
      invocationId: 'run-1',
      sources: ['https://github.com/vite-hub/example/pull/42'],
    }],
    pullRequest: 42,
    repository: 'vite-hub/example',
  })

  assert.match(content, /^# PRMemory/m)
  assert.match(content, /- A durable finding\./)
  assert.match(content, /  Its reason and effect\./)
  assert.match(content, /https:\/\/github\.com\/vite-hub\/example\/pull\/42/)
  assert.match(content, /0123456789012345678901234567890123456789/)
})

test('rejects non-URL sources', async () => {
  await assert.rejects(appendPRMemory({
    head: 'head',
    invocationId: 'run-1',
    pullRequest: 42,
    repository: 'vite-hub/example',
  }, { items: [{ content: 'Finding', sources: ['server/provider.ts'] }] }, memoryStorage() as never), /source URL/)
})
