import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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
  released?: boolean
  token: string
}

const releasedSandboxRuntimeGenerationLocks = new Set<string>()

interface SandboxRuntimeGenerationLockObservation {
  dev: number
  ino: number
  lease: {
    dev: number
    ino: number
    mtimeMs: number
  }
  ownerValue: string | undefined
}

interface SandboxRuntimeGenerationLockOperations {
  heartbeatIntervalMs?: number
  host?: string
  remove: typeof rm
  writeOwner: (path: string, value: string) => Promise<void>
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
): Promise<SandboxRuntimeGenerationLockObservation | undefined> {
  const before = await stat(lockDir).catch(() => undefined)
  if (!before)
    return undefined
  const ownerValue = await readFile(ownerPath, 'utf8').catch(() => undefined)
  const after = await stat(lockDir).catch(() => undefined)
  if (!after || before.dev !== after.dev || before.ino !== after.ino)
    return undefined
  const lease = await stat(resolve(lockDir, '.heartbeat')).catch(() => undefined)
    || await stat(ownerPath).catch(() => undefined)
    || after
  return {
    dev: after.dev,
    ino: after.ino,
    lease: { dev: lease.dev, ino: lease.ino, mtimeMs: lease.mtimeMs },
    ownerValue,
  }
}

function isSandboxRuntimeGenerationLockStale(observation: SandboxRuntimeGenerationLockObservation): boolean {
  const owner = parseSandboxRuntimeGenerationLockOwner(observation.ownerValue)
  if (owner?.released === true || (owner && releasedSandboxRuntimeGenerationLocks.has(owner.token)))
    return true
  if (owner?.host === hostname())
    return !isLocalProcessAlive(owner.pid)

  return Date.now() - observation.lease.mtimeMs > generationLockStaleMs
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
    const currentLease = await stat(resolve(lockDir, '.heartbeat')).catch(() => undefined)
      || await stat(ownerPath).catch(() => undefined)
    if (
      currentOwner !== observation.ownerValue
      || current?.dev !== observation.dev
      || current.ino !== observation.ino
      || !currentLease
      || currentLease.dev !== observation.lease.dev
      || currentLease.ino !== observation.lease.ino
      || currentLease.mtimeMs !== observation.lease.mtimeMs
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
  operation: (assertOwnership: () => Promise<void>) => Promise<T>,
  lockOperations: SandboxRuntimeGenerationLockOperations = {
    remove: rm,
    writeOwner: async (path, value) => await writeFile(path, value),
  },
): Promise<T> {
  const lockDir = resolve(generatedDir, generationLockName)
  const ownerPath = resolve(lockDir, 'owner.json')
  const heartbeatPath = resolve(lockDir, '.heartbeat')
  const owner = JSON.stringify({ host: lockOperations.host ?? hostname(), pid: process.pid, token: randomUUID() })
  const deadline = Date.now() + generationLockWaitMs
  let heartbeatFile: Awaited<ReturnType<typeof open>> | undefined
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
      heartbeatFile = await open(heartbeatPath, 'wx')
      break
    }
    catch (error) {
      await rm(lockDir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  const assertOwnership = async () => {
    const activeOwner = await readFile(ownerPath, 'utf8').catch(() => undefined)
    if (activeOwner !== owner)
      throw new Error(`[vitehub] Lost ownership while preparing the Sandbox runtime in ${generatedDir}.`)
  }
  let heartbeat = Promise.resolve()
  const heartbeatTimer = setInterval(() => {
    heartbeat = heartbeat.then(async () => {
      if (await readFile(ownerPath, 'utf8').catch(() => undefined) === owner)
        await heartbeatFile?.utimes(new Date(), new Date())
    }).catch(() => {})
  }, lockOperations.heartbeatIntervalMs ?? Math.floor(generationLockStaleMs / 3))
  heartbeatTimer.unref()

  try {
    return await operation(assertOwnership)
  }
  finally {
    clearInterval(heartbeatTimer)
    await heartbeat
    await heartbeatFile?.close().catch(() => {})
    const activeOwner = await readFile(ownerPath, 'utf8').catch(() => undefined)
    if (activeOwner === owner) {
      try {
        await lockOperations.remove(lockDir, { recursive: true, force: true })
      }
      catch {
        const parsedOwner = parseSandboxRuntimeGenerationLockOwner(owner)
        if (parsedOwner) {
          releasedSandboxRuntimeGenerationLocks.add(parsedOwner.token)
          await lockOperations.writeOwner(ownerPath, JSON.stringify({ ...parsedOwner, released: true })).catch(() => {})
        }
      }
    }
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
