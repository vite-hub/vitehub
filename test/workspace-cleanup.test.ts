import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function createHostedWorkspaceSession() {
  const require = createRequire(import.meta.url)
  const viteHubPackage = require.resolve('vite-hub/package.json')
  const nestedRequire = createRequire(viteHubPackage)
  const workspacePackage = nestedRequire.resolve('@vite-hub/workspace/package.json')
  const dist = join(dirname(workspacePackage), 'dist')
  const hostFile = (await readdir(dist)).find(file => /^host-.*\.js$/.test(file))
  assert.ok(hostFile)
  const hosted = await import(pathToFileURL(join(dist, hostFile)).href) as {
    t: (workspace: object, options: object) => Promise<{ close(options?: { abortSignal?: AbortSignal }): Promise<void> }>
  }
  return hosted.t
}

test('hosted workspace close cancels a deferred recursive snapshot', async () => {
  const startSession = await createHostedWorkspaceSession()
  let deferLists = false
  let observedSignal: AbortSignal | undefined
  const host = {
    executionAuthority: {
      credentials: 'ambient',
      environment: 'ambient',
      filesystem: { access: 'read-write', scope: 'host' },
      isolation: 'none',
      network: 'unrestricted',
      processes: 'arbitrary',
    },
    files: {
      async exists() { return true },
      async list(_path: string, options?: { signal?: AbortSignal }) {
        if (!deferLists) return []
        observedSignal = options?.signal
        assert.ok(observedSignal)
        return await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(observedSignal!.reason)
          observedSignal!.addEventListener('abort', abort, { once: true })
          if (observedSignal!.aborted) abort()
        })
      },
      async mkdir() {},
      async read() { return null },
      async remove() {},
      async write() {},
    },
    async exec(_command: string, args: string[] = [], options?: { signal?: AbortSignal }) {
      options?.signal?.throwIfAborted()
      return { code: args[0] === '-L' ? 1 : 0, stderr: '', stdout: '' }
    },
  }
  const workspace = {
    async list() { return [] },
  }
  const session = await startSession(workspace, { host, target: '/workspace' })
  deferLists = true
  const controller = new AbortController()
  const reason = new DOMException('cleanup deadline', 'TimeoutError')
  const closing = session.close({ abortSignal: controller.signal })
  while (!observedSignal) await new Promise<void>(resolve => setImmediate(resolve))
  controller.abort(reason)

  await assert.rejects(closing, (error: unknown) => error === reason)
  assert.equal(observedSignal, controller.signal)
})
