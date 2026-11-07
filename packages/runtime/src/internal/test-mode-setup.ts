import { viteHubTestModeKey } from "./test-mode.ts"

import type { ViteHubTestMode, ViteHubTestModeGlobal } from "./test-mode.ts"

interface Backend {
  dispose?: (value: never) => unknown
  value: unknown
}

let processRoot: Promise<string> | undefined

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * One folder per test process under `<root>/.vitehub/test`. A test runner can stop its workers without an exit event,
 * so each process also deletes the folders of processes that no longer run.
 */
function processTemporaryRoot(root: string): Promise<string> {
  processRoot ??= (async () => {
    const [{ rmSync }, { mkdir, mkdtemp, readdir, rm }, { join }] = await Promise.all([import("node:fs"), import("node:fs/promises"), import("node:path")])
    const parent = join(root, ".vitehub", "test")
    await mkdir(parent, { recursive: true })
    for (const name of await readdir(parent)) {
      const pid = Number(name.split("-")[0])
      if (Number.isInteger(pid) && pid !== process.pid && !isRunning(pid)) await rm(join(parent, name), { force: true, recursive: true })
    }
    const directory = await mkdtemp(join(parent, `${process.pid}-`))
    process.once("exit", () => rmSync(directory, { force: true, recursive: true }))
    return directory
  })()
  return processRoot
}

function createViteHubTestMode(root: string): ViteHubTestMode {
  const env: Record<string, string> = {}
  let backends = new Map<string, Backend>()
  let temporaryRoot: Promise<string> | undefined

  function backend<T>(key: string, create: () => T, dispose?: (value: Awaited<T>) => unknown): T {
    const existing = backends.get(key)
    // SAFETY: Each key belongs to one Primitive, which always stores the same backend type under it.
    if (existing) return existing.value as T
    const value = create()
    // SAFETY: reset() passes `dispose` only the value that it was registered with.
    backends.set(key, { dispose: dispose as Backend["dispose"], value })
    return value
  }

  function peek<T>(key: string): T | undefined {
    // SAFETY: The caller reads a key that it shares with the Primitive that created the backend.
    return backends.get(key)?.value as T | undefined
  }

  const mode: ViteHubTestMode = {
    env,
    root,
    backend,
    peek,
    async directory(key) {
      temporaryRoot ??= (async () => {
        const [{ mkdtemp }, { join }] = await Promise.all([import("node:fs/promises"), import("node:path")])
        return await mkdtemp(join(await processTemporaryRoot(root), "test-"))
      })()
      const [{ mkdir }, { join }] = await Promise.all([import("node:fs/promises"), import("node:path")])
      const directory = join(await temporaryRoot, key.replace(/[^\w.-]/g, "_"))
      await mkdir(directory, { recursive: true })
      return directory
    },
    async reset() {
      const previous = backends
      const previousRoot = temporaryRoot
      backends = new Map()
      temporaryRoot = undefined
      for (const name of Object.keys(env)) delete env[name]
      const failures: unknown[] = []
      for (const { dispose, value } of previous.values()) {
        try {
          // SAFETY: `dispose` was registered with the backend that it receives.
          await dispose?.(await value as never)
        }
        catch (error) {
          failures.push(error)
        }
      }
      if (previousRoot) {
        const { rm } = await import("node:fs/promises")
        await rm(await previousRoot, { force: true, recursive: true })
      }
      if (failures.length) throw new AggregateError(failures, "[vitehub] A test backend failed to close.")
    },
  }
  return mode
}

/** Turns test mode on for this process, or returns the active one. */
export function enableViteHubTestMode(options: { root?: string } = {}): ViteHubTestMode {
  const target = globalThis as ViteHubTestModeGlobal
  const root = options.root ?? (typeof process === "object" ? process.cwd() : "/")
  const existing = target[viteHubTestModeKey]
  if (existing && existing.root === root) return existing
  const mode = createViteHubTestMode(root)
  target[viteHubTestModeKey] = mode
  return mode
}
