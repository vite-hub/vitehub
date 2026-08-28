import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { basename, resolve } from 'pathe'

const generationMarker = '// vitehub-sandbox-generation: '
const generationLockClaimStaleMs = 60_000
const generationLockName = '.runtime-generation.lock'
const generationLockWaitMs = 60_000
const generationLockStaleMs = 300_000

interface SandboxRuntimeGenerationLockOwner {
  host: string
  pid: number
  token: string
}

interface SandboxRuntimeGenerationLockObservation {
  dev: number
  ino: number
  mtimeMs: number
  ownerValue: string | undefined
}

function readNodeErrorCode(error: unknown) {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

function parseSandboxRuntimeGenerationLockOwner(value: string | undefined): SandboxRuntimeGenerationLockOwner | undefined {
  if (!value)
    return undefined

  try {
    const owner = JSON.parse(value) as Partial<SandboxRuntimeGenerationLockOwner>
    return typeof owner.host === 'string'
      && Number.isSafeInteger(owner.pid)
      && Number(owner.pid) > 0
      && typeof owner.token === 'string'
      ? owner as SandboxRuntimeGenerationLockOwner
      : undefined
  }
  catch {
    return undefined
  }
}

function isLocalProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return readNodeErrorCode(error) !== 'ESRCH'
  }
}

async function observeSandboxRuntimeGenerationLock(
  lockDir: string,
  ownerPath: string,
): Promise<SandboxRuntimeGenerationLockObservation | undefined> {
  const before = await stat(lockDir).catch(() => undefined)
  if (!before)
    return undefined
  const ownerValue = await readFile(ownerPath, 'utf8').catch(() => undefined)
  const after = await stat(lockDir).catch(() => undefined)
  if (!after || before.dev !== after.dev || before.ino !== after.ino)
    return undefined
  return { dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs, ownerValue }
}

function isSandboxRuntimeGenerationLockStale(observation: SandboxRuntimeGenerationLockObservation): boolean {
  const owner = parseSandboxRuntimeGenerationLockOwner(observation.ownerValue)
  if (owner?.host === hostname())
    return !isLocalProcessAlive(owner.pid)

  return Date.now() - observation.mtimeMs > generationLockStaleMs
}

async function reclaimSandboxRuntimeGenerationLock(
  lockDir: string,
  ownerPath: string,
  observation: SandboxRuntimeGenerationLockObservation,
): Promise<boolean> {
  const claimPath = resolve(lockDir, '.reclaim')
  let claim: Awaited<ReturnType<typeof open>> | undefined
  while (!claim) {
    try {
      claim = await open(claimPath, 'wx')
    }
    catch (error) {
      const code = readNodeErrorCode(error)
      if (code === 'ENOENT')
        return false
      if (code !== 'EEXIST')
        throw error

      const claimInfo = await stat(claimPath).catch(() => undefined)
      if (!claimInfo || Date.now() - claimInfo.mtimeMs <= generationLockClaimStaleMs)
        return false
      await rm(claimPath, { force: true }).catch(() => {})
    }
  }
  await claim.close()

  let reclaimed = false
  try {
    const currentOwner = await readFile(ownerPath, 'utf8').catch(() => undefined)
    const current = await stat(lockDir).catch(() => undefined)
    if (
      currentOwner !== observation.ownerValue
      || current?.dev !== observation.dev
      || current.ino !== observation.ino
    )
      return false

    const staleDir = `${lockDir}.stale-${randomUUID()}`
    reclaimed = await rename(lockDir, staleDir).then(() => true, (error) => {
      if (readNodeErrorCode(error) === 'ENOENT')
        return false
      throw error
    })
    if (reclaimed)
      await rm(staleDir, { recursive: true, force: true })
    return reclaimed
  }
  finally {
    if (!reclaimed)
      await rm(claimPath, { force: true }).catch(() => {})
  }
}

export async function withSandboxRuntimeGenerationLock<T>(
  generatedDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockDir = resolve(generatedDir, generationLockName)
  const ownerPath = resolve(lockDir, 'owner.json')
  const owner = JSON.stringify({ host: hostname(), pid: process.pid, token: randomUUID() })
  const deadline = Date.now() + generationLockWaitMs
  await mkdir(generatedDir, { recursive: true })

  while (true) {
    try {
      await mkdir(lockDir)
    }
    catch (error) {
      if (readNodeErrorCode(error) !== 'EEXIST')
        throw error

      const observation = await observeSandboxRuntimeGenerationLock(lockDir, ownerPath)
      if (observation && isSandboxRuntimeGenerationLockStale(observation)) {
        await reclaimSandboxRuntimeGenerationLock(lockDir, ownerPath, observation)
        continue
      }
      if (Date.now() >= deadline)
        throw new Error(`[vitehub] Timed out waiting to prepare the Sandbox runtime in ${generatedDir}.`)
      await delay(25)
      continue
    }

    try {
      const ownerFile = await open(ownerPath, 'wx')
      try {
        await ownerFile.writeFile(owner)
      }
      finally {
        await ownerFile.close()
      }
      break
    }
    catch (error) {
      await rm(lockDir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  try {
    return await operation()
  }
  finally {
    const activeOwner = await readFile(ownerPath, 'utf8').catch(() => undefined)
    if (activeOwner === owner)
      await rm(lockDir, { recursive: true, force: true })
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
