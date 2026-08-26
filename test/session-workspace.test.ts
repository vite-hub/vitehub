import assert from 'node:assert/strict'
import test from 'node:test'
import { assertWorkspacePath, readWorkspaceFile, readWorkspaceTree } from '../server/session-workspace.ts'
import type { SessionSnapshot } from '../server/session-snapshots.ts'

const snapshot: SessionSnapshot = {
  createdAt: '2026-08-24T10:00:00.000Z',
  events: [],
  invocationId: 'run-1',
  paths: ['README.md', 'src/index.ts'],
  pullRequest: 42,
  repository: 'vite-hub/example',
  revision: '0123456789012345678901234567890123456789',
  updatedAt: '2026-08-24T10:00:00.000Z',
}

test('loads only blob paths from an immutable GitHub tree', async () => {
  const calls: string[][] = []
  const paths = await readWorkspaceTree(snapshot.repository, snapshot.revision, async (args) => {
    calls.push(args)
    return { stderr: '', stdout: JSON.stringify({ tree: [
      { path: 'src', type: 'tree' },
      { path: 'src/index.ts', type: 'blob' },
      { path: 'README.md', type: 'blob' },
    ] }) }
  })
  assert.deepEqual(paths, ['README.md', 'src/index.ts'])
  assert.match(calls[0]!.join(' '), /recursive=1/)
  assert.match(calls[0]!.join(' '), new RegExp(snapshot.revision))
})

test('loads one manifest file by exact revision', async () => {
  const file = await readWorkspaceFile(snapshot, 'src/index.ts', async (args) => {
    assert.match(args.join(' '), /ref=0123456789012345678901234567890123456789/)
    return { stderr: '', stdout: JSON.stringify({
      content: Buffer.from('export const answer = 42\n').toString('base64'),
      encoding: 'base64',
      size: 25,
      type: 'file',
    }) }
  })
  assert.equal(file.content, 'export const answer = 42\n')
  assert.equal(file.path, 'src/index.ts')
})

test('rejects traversal and files outside the recorded manifest', async () => {
  assert.throws(() => assertWorkspacePath('../secret'), /Invalid Workspace path/)
  await assert.rejects(readWorkspaceFile(snapshot, 'package.json', async () => {
    throw new Error('should not request GitHub')
  }), /not part of this Workspace snapshot/)
})
