import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { basename, resolve } from 'pathe'

const generationMarker = '// vitehub-sandbox-generation: '
const generationLockClaimStaleMs = 60_000
const generationLockName = '.runtime-generation.lock'
const generationLockWaitMs = 60_000
const generationLockStaleMs = 300_000
const generationLockHeartbeatMs = 30_000

interface SandboxRuntimeGenerationLockOwner {
  host: string
  pid: number
  released?: boolean
  token: string
}

const releasedSandboxRuntimeGenerationLocks = new Set<string>()

interface SandboxRuntimeGenerationLockObservation {
  dev: number
  ino: number
  leaseDev?: number
  leaseIno?: number
  leaseMtimeMs: number
  ownerValue: string | undefined
}

export interface SandboxRuntimeGenerationLease {
  assertOwned: () => Promise<void>
}

interface SandboxRuntimeGenerationLockOptions {
  heartbeatMs?: number
  host?: string
  pollMs?: number
  removeLock?: typeof rm
  staleMs?: number
  waitMs?: number
}

function readNodeErrorCode(error: unknown) {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

function parseSandboxRuntimeGenerationLockOwner(value: string | undefined): SandboxRuntimeGenerationLockOwner | undefined {
  if (!value)
    return undefined

  try {
    const parsed: unknown = JSON.parse(value)
    if (Object(parsed) !== parsed || Array.isArray(parsed))
      return undefined
    const host = Reflect.get(Object(parsed), 'host')
    const pid = Reflect.get(Object(parsed), 'pid')
    const released = Reflect.get(Object(parsed), 'released')
    const token = Reflect.get(Object(parsed), 'token')
    if (String(host) !== host
      || !Number.isSafeInteger(pid)
      || Number(pid) <= 0
      || !(released === undefined || released === true || released === false)
      || String(token) !== token)
      return undefined
    const owner: SandboxRuntimeGenerationLockOwner = {
      host: String(host),
      pid: Number(pid),
      token: String(token),
    }
    if (released === true)
      owner.released = true
    return owner
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
  leasePath: string,
): Promise<SandboxRuntimeGenerationLockObservation | undefined> {
  const before = await stat(lockDir).catch(() => undefined)
  if (!before)
    return undefined
  const ownerValue = await readFile(ownerPath, 'utf8').catch(() => undefined)
  const lease = await stat(leasePath).catch(() => undefined)
  const after = await stat(lockDir).catch(() => undefined)
  if (!after || before.dev !== after.dev || before.ino !== after.ino)
    return undefined
  return {
    dev: after.dev,
    ino: after.ino,
    leaseDev: lease?.dev,
    leaseIno: lease?.ino,
    leaseMtimeMs: lease?.mtimeMs ?? after.mtimeMs,
    ownerValue,
  }
}

function isSandboxRuntimeGenerationLockStale(
  observation: SandboxRuntimeGenerationLockObservation,
  staleMs: number,
): boolean {
  const owner = parseSandboxRuntimeGenerationLockOwner(observation.ownerValue)
  if (owner?.released === true || (owner && releasedSandboxRuntimeGenerationLocks.has(owner.token)))
    return true
  if (owner?.host === hostname())
    return !isLocalProcessAlive(owner.pid)

  return Date.now() - observation.leaseMtimeMs > staleMs
}

function isSameSandboxRuntimeGenerationLock(
  left: SandboxRuntimeGenerationLockObservation,
  right: SandboxRuntimeGenerationLockObservation | undefined,
): boolean {
  return !!right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.leaseDev === right.leaseDev
    && left.leaseIno === right.leaseIno
    && (typeof left.leaseIno === 'undefined' || left.leaseMtimeMs === right.leaseMtimeMs)
    && left.ownerValue === right.ownerValue
}

async function reclaimSandboxRuntimeGenerationLock(
  lockDir: string,
  ownerPath: string,
  leasePath: string,
  observation: SandboxRuntimeGenerationLockObservation,
  staleMs: number,
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
    const current = await observeSandboxRuntimeGenerationLock(lockDir, ownerPath, leasePath)
    const stillStale = typeof current?.leaseIno === 'undefined'
      ? isSandboxRuntimeGenerationLockStale(observation, staleMs)
      : isSandboxRuntimeGenerationLockStale(current, staleMs)
    if (!isSameSandboxRuntimeGenerationLock(observation, current)
      || !current
      || !stillStale)
      return false

    const staleDir = `${lockDir}.stale-${randomUUID()}`
    reclaimed = await rename(lockDir, staleDir).then(() => true, (error) => {
      if (readNodeErrorCode(error) === 'ENOENT')
        return false
      throw error
    })
    if (reclaimed)
      await rm(staleDir, { recursive: true, force: true })
    if (reclaimed) {
      const owner = parseSandboxRuntimeGenerationLockOwner(observation.ownerValue)
      if (owner)
        releasedSandboxRuntimeGenerationLocks.delete(owner.token)
    }
    return reclaimed
  }
  finally {
    if (!reclaimed)
      await rm(claimPath, { force: true }).catch(() => {})
  }
}

export async function withSandboxRuntimeGenerationLock<T>(
  generatedDir: string,
  operation: (lease: SandboxRuntimeGenerationLease) => Promise<T>,
  options: SandboxRuntimeGenerationLockOptions = {},
): Promise<T> {
  const lockDir = resolve(generatedDir, generationLockName)
  const ownerPath = resolve(lockDir, 'owner.json')
  const leasePath = resolve(lockDir, 'lease')
  const heartbeatMs = options.heartbeatMs ?? generationLockHeartbeatMs
  const pollMs = options.pollMs ?? 25
  const removeLock = options.removeLock ?? rm
  const staleMs = options.staleMs ?? generationLockStaleMs
  const owner = JSON.stringify({ host: options.host ?? hostname(), pid: process.pid, token: randomUUID() })
  const deadline = Date.now() + (options.waitMs ?? generationLockWaitMs)
  let ownedLock: SandboxRuntimeGenerationLockObservation | undefined
  let leaseFile: Awaited<ReturnType<typeof open>> | undefined
  await mkdir(generatedDir, { recursive: true })

  while (true) {
    try {
      await mkdir(lockDir)
    }
    catch (error) {
      if (readNodeErrorCode(error) !== 'EEXIST')
        throw error

      const observation = await observeSandboxRuntimeGenerationLock(lockDir, ownerPath, leasePath)
      if (observation && isSandboxRuntimeGenerationLockStale(observation, staleMs)) {
        await reclaimSandboxRuntimeGenerationLock(lockDir, ownerPath, leasePath, observation, staleMs)
        continue
      }
      if (Date.now() >= deadline)
        throw new Error(`[vitehub] Timed out waiting to prepare the Sandbox runtime in ${generatedDir}.`)
      await delay(pollMs)
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
      leaseFile = await open(leasePath, 'wx')
      await leaseFile.writeFile(owner)
      ownedLock = await observeSandboxRuntimeGenerationLock(lockDir, ownerPath, leasePath)
      if (!ownedLock)
        throw new Error(`[vitehub] Lost ownership while preparing the Sandbox runtime in ${generatedDir}.`)
      break
    }
    catch (error) {
      await leaseFile?.close().catch(() => {})
      leaseFile = undefined
      await rm(lockDir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  let heartbeatError: unknown
  const assertOwned = async () => {
    if (heartbeatError)
      throw new Error(`[vitehub] Lost ownership while preparing the Sandbox runtime in ${generatedDir}.`, { cause: heartbeatError })
    const active = await observeSandboxRuntimeGenerationLock(lockDir, ownerPath, leasePath)
    if (!ownedLock
      || !active
      || active.dev !== ownedLock.dev
      || active.ino !== ownedLock.ino
      || active.leaseDev !== ownedLock.leaseDev
      || active.leaseIno !== ownedLock.leaseIno
      || active.ownerValue !== owner) {
      throw new Error(`[vitehub] Lost ownership while preparing the Sandbox runtime in ${generatedDir}.`)
    }
  }
  const heartbeatAbort = new AbortController()
  const heartbeat = (async () => {
    while (!heartbeatAbort.signal.aborted) {
      try {
        await delay(heartbeatMs, undefined, { signal: heartbeatAbort.signal })
      }
      catch (error) {
        if (heartbeatAbort.signal.aborted)
          return
        throw error
      }
      if (heartbeatAbort.signal.aborted)
        return
      const now = new Date()
      await leaseFile!.utimes(now, now)
      await assertOwned()
    }
  })().catch((error) => {
    heartbeatError = error
  })

  let operationFailed = false
  let operationError: unknown
  let operationResult: T | undefined
  try {
    operationResult = await operation({ assertOwned })
  }
  catch (error) {
    operationFailed = true
    operationError = error
  }

  const cleanupErrors: unknown[] = []
  heartbeatAbort.abort()
  await heartbeat.catch(error => cleanupErrors.push(error))
  if (heartbeatError) {
    cleanupErrors.push(new Error(
      `[vitehub] Lost ownership while preparing the Sandbox runtime in ${generatedDir}.`,
      { cause: heartbeatError },
    ))
  }
  await leaseFile?.close().catch(error => cleanupErrors.push(error))
  const activeOwner = await readFile(ownerPath, 'utf8').catch(() => undefined)
  const active = await observeSandboxRuntimeGenerationLock(lockDir, ownerPath, leasePath)
  const stillOwned = activeOwner === owner
    && ownedLock
    && active?.dev === ownedLock.dev
    && active.ino === ownedLock.ino
    && active.leaseDev === ownedLock.leaseDev
    && active.leaseIno === ownedLock.leaseIno
  if (stillOwned) {
    try {
      await removeLock(lockDir, { recursive: true, force: true })
    }
    catch (releaseError) {
      try {
        const expired = new Date(0)
        await writeFile(ownerPath, JSON.stringify({ host: `${hostname()}:released`, pid: process.pid, token: randomUUID() }))
        await utimes(leasePath, expired, expired)
      }
      catch (recoveryError) {
        cleanupErrors.push(new AggregateError(
          [releaseError, recoveryError],
          `[vitehub] Failed to release the Sandbox runtime generation lock in ${generatedDir}.`,
        ))
      }
    }
  }
  else if (!heartbeatError) {
    cleanupErrors.push(new Error(`[vitehub] Lost ownership while preparing the Sandbox runtime in ${generatedDir}.`))
  }

  if (operationFailed) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        `[vitehub] Sandbox runtime preparation and generation lock cleanup failed in ${generatedDir}.`,
      )
    }
    throw operationError
  }
  if (cleanupErrors.length === 1)
    throw cleanupErrors[0]
  if (cleanupErrors.length > 1)
    throw new AggregateError(cleanupErrors, `[vitehub] Failed to clean up the Sandbox runtime generation lock in ${generatedDir}.`)
  return operationResult as T
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

export type SandboxRuntimeFacadeImportBases = {
  local: string
  package: string
}

export function resolveSandboxRuntimeFacadeImportBases(
  runtimeDir: string,
  generationFacadeFile: string,
  platform: NodeJS.Platform,
): SandboxRuntimeFacadeImportBases {
  const stableFacadeFile = resolve(runtimeDir, 'sandbox.mjs')
  return {
    local: platform === 'win32' ? stableFacadeFile : generationFacadeFile,
    package: stableFacadeFile,
  }
}

export async function pruneSandboxRuntimeGeneration(
  path: string,
  remove: typeof rm = rm,
): Promise<void> {
  await remove(path, { recursive: true, force: true }).catch(() => {})
}
