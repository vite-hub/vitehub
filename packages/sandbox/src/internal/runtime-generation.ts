import { randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { basename, resolve } from 'pathe'

const generationMarker = '// vitehub-sandbox-generation: '
const generationLockClaimStaleMs = 60_000
const generationLockInitializationStaleMs = 5_000
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
  publicationValue: string | undefined
}

export interface SandboxRuntimeGenerationLease {
  assertOwned: () => Promise<void>
  publish: <T>(operation: () => Promise<T>) => Promise<T>
}

interface SandboxRuntimeGenerationLockOptions {
  beforeInitializeLock?: () => Promise<void>
  heartbeatMs?: number
  host?: string
  pollMs?: number
  removeLock?: typeof rm
  retireLock?: typeof rename
  staleMs?: number
  waitMs?: number
  writeReleasedOwner?: (
    ownerFile: Awaited<ReturnType<typeof open>>,
    value: string,
  ) => Promise<void>
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
  publicationPath: string,
): Promise<SandboxRuntimeGenerationLockObservation | undefined> {
  const before = await stat(lockDir).catch(() => undefined)
  if (!before)
    return undefined
  const ownerValue = await readFile(ownerPath, 'utf8').catch(() => undefined)
  const publicationValue = await readFile(publicationPath, 'utf8').catch(() => undefined)
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
    publicationValue,
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
  if (owner && observation.publicationValue === owner.token)
    return false
  if (!owner || observation.leaseIno === undefined) {
    return Date.now() - observation.leaseMtimeMs
      > Math.min(staleMs, generationLockInitializationStaleMs)
  }

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
    && (left.leaseIno === undefined || left.leaseMtimeMs === right.leaseMtimeMs)
    && left.ownerValue === right.ownerValue
    && left.publicationValue === right.publicationValue
}

function isSameSandboxRuntimeGenerationLockDirectory(
  left: SandboxRuntimeGenerationLockObservation,
  right: SandboxRuntimeGenerationLockObservation | undefined,
): boolean {
  return !!right && left.dev === right.dev && left.ino === right.ino
}

async function reclaimSandboxRuntimeGenerationLock(
  lockDir: string,
  ownerPath: string,
  leasePath: string,
  publicationPath: string,
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
    const current = await observeSandboxRuntimeGenerationLock(lockDir, ownerPath, leasePath, publicationPath)
    const stillStale = current?.leaseIno === undefined
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

async function retireSandboxRuntimeGenerationLock(
  lockDir: string,
  ownerPath: string,
  leasePath: string,
  publicationPath: string,
  observation: SandboxRuntimeGenerationLockObservation,
  markReleased: () => Promise<void>,
  retireLock: typeof rename,
): Promise<string | undefined> {
  const claimPath = resolve(lockDir, '.reclaim')
  let claim: Awaited<ReturnType<typeof open>>
  try {
    claim = await open(claimPath, 'wx')
  }
  catch (error) {
    if (readNodeErrorCode(error) === 'ENOENT' || readNodeErrorCode(error) === 'EEXIST')
      return
    throw error
  }
  await claim.close()

  let retired = false
  try {
    const current = await observeSandboxRuntimeGenerationLock(lockDir, ownerPath, leasePath, publicationPath)
    if (!isSameSandboxRuntimeGenerationLock(observation, current))
      return
    await markReleased()
    const released = await observeSandboxRuntimeGenerationLock(lockDir, ownerPath, leasePath, publicationPath)
    if (!isSameSandboxRuntimeGenerationLockDirectory(observation, released))
      return
    const retiredDir = `${lockDir}.released-${randomUUID()}`
    retired = await retireLock(lockDir, retiredDir).then(() => true, (error) => {
      if (readNodeErrorCode(error) === 'ENOENT')
        return false
      throw error
    })
    return retired ? retiredDir : undefined
  }
  finally {
    if (!retired)
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
  const publicationPath = resolve(lockDir, 'publication')
  const heartbeatMs = options.heartbeatMs ?? generationLockHeartbeatMs
  const pollMs = options.pollMs ?? 25
  const removeLock = options.removeLock ?? rm
  const retireLock = options.retireLock ?? rename
  const staleMs = options.staleMs ?? generationLockStaleMs
  const writeReleasedOwner = options.writeReleasedOwner ?? (async (file, value) => {
    await file.write(value, 0, 'utf8')
    await file.truncate(Buffer.byteLength(value))
  })
  const ownerRecord = { host: options.host ?? hostname(), pid: process.pid, token: randomUUID() }
  const owner = JSON.stringify(ownerRecord)
  const deadline = Date.now() + (options.waitMs ?? generationLockWaitMs)
  let ownedLock: SandboxRuntimeGenerationLockObservation | undefined
  let createdLock: SandboxRuntimeGenerationLockObservation | undefined
  let leaseFile: Awaited<ReturnType<typeof open>> | undefined
  let ownerFile: Awaited<ReturnType<typeof open>> | undefined
  await mkdir(generatedDir, { recursive: true })

  while (true) {
    try {
      await mkdir(lockDir)
    }
    catch (error) {
      if (readNodeErrorCode(error) !== 'EEXIST')
        throw error

      const observation = await observeSandboxRuntimeGenerationLock(lockDir, ownerPath, leasePath, publicationPath)
      if (observation && isSandboxRuntimeGenerationLockStale(observation, staleMs)) {
        await reclaimSandboxRuntimeGenerationLock(lockDir, ownerPath, leasePath, publicationPath, observation, staleMs)
        continue
      }
      if (Date.now() >= deadline)
        throw new Error(`[vitehub] Timed out waiting to prepare the Sandbox runtime in ${generatedDir}.`)
      await delay(pollMs)
      continue
    }

    try {
      const created = await observeSandboxRuntimeGenerationLock(lockDir, ownerPath, leasePath, publicationPath)
      if (!created || created.ownerValue !== undefined || created.leaseIno !== undefined)
        throw new Error(`[vitehub] Lost ownership while preparing the Sandbox runtime in ${generatedDir}.`)
      createdLock = created
      await options.beforeInitializeLock?.()
      ownerFile = await open(ownerPath, 'wx')
      await ownerFile.writeFile(owner)
      leaseFile = await open(leasePath, 'wx')
      await leaseFile.writeFile(owner)
      ownedLock = await observeSandboxRuntimeGenerationLock(lockDir, ownerPath, leasePath, publicationPath)
      if (!ownedLock)
        throw new Error(`[vitehub] Lost ownership while preparing the Sandbox runtime in ${generatedDir}.`)
      break
    }
    catch (error) {
      await leaseFile?.close().catch(() => {})
      leaseFile = undefined
      await ownerFile?.close().catch(() => {})
      ownerFile = undefined
      const failed = await observeSandboxRuntimeGenerationLock(lockDir, ownerPath, leasePath, publicationPath)
      const failedOwnerBelongsToAttempt = failed?.ownerValue === owner
        || (failed?.ownerValue === undefined && failed?.leaseIno === undefined)
      if (createdLock
        && isSameSandboxRuntimeGenerationLockDirectory(createdLock, failed)
        && failed
        && failedOwnerBelongsToAttempt) {
        const retiredDir = await retireSandboxRuntimeGenerationLock(
          lockDir,
          ownerPath,
          leasePath,
          publicationPath,
          failed,
          async () => {},
          rename,
        ).catch(() => undefined)
        if (retiredDir)
          await rm(retiredDir, { recursive: true, force: true }).catch(() => {})
      }
      throw error
    }
  }

  let heartbeatError: unknown
  const assertOwned = async () => {
    if (heartbeatError)
      throw new Error(`[vitehub] Lost ownership while preparing the Sandbox runtime in ${generatedDir}.`, { cause: heartbeatError })
    const active = await observeSandboxRuntimeGenerationLock(lockDir, ownerPath, leasePath, publicationPath)
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
  const publish = async <T>(publication: () => Promise<T>) => {
    await assertOwned()
    const publicationFile = await open(publicationPath, 'wx')
    try {
      await publicationFile.writeFile(ownerRecord.token)
    }
    finally {
      await publicationFile.close()
    }

    try {
      await assertOwned()
      return await publication()
    }
    finally {
      await assertOwned()
      await rm(publicationPath, { force: true })
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
  let operationResult: { value: T } | undefined
  try {
    operationResult = { value: await operation({ assertOwned, publish }) }
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
  const activeOwner = await readFile(ownerPath, 'utf8').catch(() => undefined)
  const active = await observeSandboxRuntimeGenerationLock(lockDir, ownerPath, leasePath, publicationPath)
  const stillOwned = activeOwner === owner
    && ownedLock
    && active?.dev === ownedLock.dev
    && active.ino === ownedLock.ino
    && active.leaseDev === ownedLock.leaseDev
    && active.leaseIno === ownedLock.leaseIno
  if (stillOwned) {
    releasedSandboxRuntimeGenerationLocks.add(ownerRecord.token)
    const markReleased = async () => {
      const releasedOwner = JSON.stringify({ ...ownerRecord, released: true })
      await writeReleasedOwner(ownerFile!, releasedOwner)
      const expired = new Date(0)
      await leaseFile!.utimes(expired, expired)
    }
    let retiredDir: string | undefined
    try {
      retiredDir = await retireSandboxRuntimeGenerationLock(
        lockDir,
        ownerPath,
        leasePath,
        publicationPath,
        active,
        markReleased,
        retireLock,
      )
    }
    catch (releaseError) {
      try {
        await markReleased()
      }
      catch (recoveryError) {
        cleanupErrors.push(new AggregateError(
          [releaseError, recoveryError],
          `[vitehub] Failed to release the Sandbox runtime generation lock in ${generatedDir}.`,
        ))
      }
    }
    if (!retiredDir && cleanupErrors.length === 0) {
      await markReleased().catch(error => cleanupErrors.push(error))
    }
    await leaseFile?.close().catch(error => cleanupErrors.push(error))
    leaseFile = undefined
    await ownerFile?.close().catch(error => cleanupErrors.push(error))
    ownerFile = undefined
    if (retiredDir) {
      await removeLock(retiredDir, { recursive: true, force: true }).catch(() => {})
      releasedSandboxRuntimeGenerationLocks.delete(ownerRecord.token)
    }
  }
  else if (!heartbeatError) {
    cleanupErrors.push(new Error(`[vitehub] Lost ownership while preparing the Sandbox runtime in ${generatedDir}.`))
  }
  await leaseFile?.close().catch(error => cleanupErrors.push(error))
  await ownerFile?.close().catch(error => cleanupErrors.push(error))

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
  if (!operationResult)
    throw new Error(`[vitehub] Sandbox runtime preparation completed without a result in ${generatedDir}.`)
  return operationResult.value
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

export async function restoreSandboxRuntimeGeneration(
  previousRuntime: string,
  activeRuntime: string,
  lease: Pick<SandboxRuntimeGenerationLease, 'assertOwned'>,
  move: typeof rename = rename,
): Promise<void> {
  await lease.assertOwned()
  const activeRuntimeExists = await lstat(activeRuntime).then(
    () => true,
    (error) => {
      if (readNodeErrorCode(error) === 'ENOENT')
        return false
      throw error
    },
  )
  if (activeRuntimeExists)
    throw new Error(`[vitehub] Sandbox runtime changed during activation; the previous runtime is retained at ${previousRuntime}.`)
  await lease.assertOwned()
  await move(previousRuntime, activeRuntime)
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
