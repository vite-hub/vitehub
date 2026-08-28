import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { basename, resolve } from 'pathe'

const generationMarker = '// vitehub-sandbox-generation: '

type SandboxRuntimeLockOwner = {
  host: string
  pid: number
  token: string
}

async function readSandboxRuntimeLockOwner(lock: string): Promise<SandboxRuntimeLockOwner | undefined> {
  const owner = await readFile(resolve(lock, 'owner.json'), 'utf8').catch(() => undefined)
  if (!owner)
    return undefined
  const [host, pidText, token] = owner.split('\n')
  if (!host || !pidText || !token || !/^\d+$/.test(pidText))
    return undefined
  const pid = Number(pidText)
  return Number.isSafeInteger(pid) ? { host, pid, token } : undefined
}

async function staleSandboxRuntimeLock(lock: string): Promise<string | undefined> {
  const owner = await readSandboxRuntimeLockOwner(lock)
  if (!owner) {
    const item = await stat(lock).catch(() => undefined)
    return item && Date.now() - item.mtimeMs > 5_000
      ? `invalid-${item.dev}-${item.ino}-${Math.floor(item.mtimeMs)}`
      : undefined
  }
  if (owner.host !== hostname())
    return undefined
  try {
    process.kill(owner.pid, 0)
    return undefined
  }
  catch (error) {
    return Reflect.get(Object(error), 'code') === 'ESRCH' ? owner.token : undefined
  }
}

export async function withSandboxRuntimeGenerationLock<T>(
  generatedDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = resolve(generatedDir, '.runtime-generation.lock')
  const token = randomUUID()
  while (true) {
    const acquired = await mkdir(lock, { mode: 0o700 }).then(
      () => true,
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST')
          throw error
        const staleToken = await staleSandboxRuntimeLock(lock)
        if (!staleToken)
          return false
        const tombstone = `${lock}.stale-${staleToken}`
        const reclaimed = await rename(lock, tombstone).then(() => true, () => false)
        if (reclaimed)
          await rm(tombstone, { force: true, recursive: true })
        return false
      },
    )
    if (acquired) {
      try {
        await writeFile(resolve(lock, 'owner.json'), `${hostname()}\n${process.pid}\n${token}\n`)
      }
      catch (error) {
        await rm(lock, { force: true, recursive: true }).catch(() => undefined)
        throw error
      }
      break
    }
    await delay(25)
  }
  try {
    return await operation()
  }
  finally {
    const owner = await readSandboxRuntimeLockOwner(lock)
    if (owner?.token === token)
      await rm(lock, { force: true, recursive: true })
  }
}

export function markSandboxRuntimeGeneration(contents: string, generationDir: string): string {
  return `${generationMarker}${basename(generationDir)}\n${contents}`
}

export async function readSandboxRuntimeGeneration(
  facadeFile: string,
  generationsDir: string,
): Promise<string | undefined> {
  const contents = await readFile(facadeFile, 'utf8').catch(() => undefined)
  const name = contents?.split('\n', 1)[0]?.slice(generationMarker.length)
  return name?.startsWith('runtime-') && basename(name) === name ? resolve(generationsDir, name) : undefined
}

interface SandboxRuntimeFileOperations {
  copyFile: typeof copyFile
  rename: typeof rename
  rm: typeof rm
}

export async function activateSandboxRuntimeFile(
  source: string,
  target: string,
  staged: string,
  operations: SandboxRuntimeFileOperations = { copyFile, rename, rm },
): Promise<void> {
  await operations.copyFile(source, staged)
  try {
    await operations.rename(staged, target)
  }
  finally {
    await operations.rm(staged, { force: true }).catch(() => {})
  }
}

export function resolveSandboxRuntimeLinkType(platform: NodeJS.Platform): 'dir' | 'junction' {
  return platform === 'win32' ? 'junction' : 'dir'
}

export function resolveSandboxRuntimeFacadeImportBase(
  runtimeDir: string,
  generationFacadeFile: string,
  platform: NodeJS.Platform,
): string {
  return platform === 'win32' ? resolve(runtimeDir, 'sandbox.mjs') : generationFacadeFile
}

export async function pruneSandboxRuntimeGeneration(
  path: string,
  remove: typeof rm = rm,
): Promise<void> {
  await remove(path, { recursive: true, force: true }).catch(() => {})
}
