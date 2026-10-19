import { describe, expect, it } from 'vitest'

import { resolveSandboxTaskModulePath, writeSandboxTaskDefinitionBundle } from '../src/runtime/execution-files.ts'
import type { TaskSandbox } from '../src/runtime/task-sandbox.ts'

function createSandbox() {
  const writes: string[] = []
  const sandbox = {
    executionAuthority: {} as never,
    id: 'test',
    provider: 'vercel',
    close: async () => {},
    exec: async () => ({ code: 0, ok: true, stderr: '', stdout: '' }),
    exists: async () => false,
    mkdir: async () => {},
    readFile: async () => '',
    writeFile: async () => {},
    files: {
      exists: async () => false,
      list: async () => [],
      mkdir: async () => {},
      read: async () => null,
      remove: async () => {},
      write: async (path: string) => { writes.push(path) },
    },
  } as unknown as TaskSandbox
  return { sandbox, writes }
}

describe('sandbox task execution file paths', () => {
  it('resolves an entry with Windows separators to the path written by the bundle writer', async () => {
    const { sandbox, writes } = createSandbox()
    const bundle = {
      entry: 'src\\definition.mjs',
      modules: { 'src\\definition.mjs': 'export default {}' },
    }

    await writeSandboxTaskDefinitionBundle(sandbox, '/tmp/bundle', bundle)

    expect(writes).toContain('/tmp/bundle/src/definition.mjs')
    expect(resolveSandboxTaskModulePath('/tmp/bundle', bundle.entry)).toBe('/tmp/bundle/src/definition.mjs')
  })
})
