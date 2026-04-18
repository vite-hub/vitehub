import { spawn } from 'node:child_process'
import process from 'node:process'

export interface ManagedProcessHandle {
  id: string
  ready: Promise<void>
  stop: () => Promise<void>
}

export interface EnsureManagedProcessOptions {
  feature: string
  provider: string
  rootDir: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  startTimeoutMs?: number
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
  isReady?: (line: string, stream: 'stdout' | 'stderr') => boolean
}

type ManagedProcessRecord = ManagedProcessHandle & {
  child: ReturnType<typeof spawn>
  stopped: boolean
}

const managedProcessRegistryKey = Symbol.for('vitehub.dev.process.registry')

function getManagedProcessRegistry() {
  const globalState = globalThis as typeof globalThis & {
    [managedProcessRegistryKey]?: Map<string, ManagedProcessRecord>
  }

  if (!globalState[managedProcessRegistryKey])
    globalState[managedProcessRegistryKey] = new Map<string, ManagedProcessRecord>()

  return globalState[managedProcessRegistryKey]
}

export function getManagedProcessId(feature: string, provider: string, rootDir: string) {
  return `${feature}:${provider}:${rootDir}`
}

function toLines(
  chunk: string,
  stream: 'stdout' | 'stderr',
  buffer: { value: string },
  onLine?: EnsureManagedProcessOptions['onLine'],
  isReady?: EnsureManagedProcessOptions['isReady'],
) {
  const lines = `${buffer.value}${chunk}`.split(/\r?\n/g)
  buffer.value = lines.pop() || ''

  for (const line of lines) {
    onLine?.(line, stream)
    if (isReady?.(line, stream))
      return true
  }

  return false
}

async function stopRecord(record: ManagedProcessRecord) {
  if (record.stopped)
    return

  record.stopped = true
  if (record.child.exitCode !== null)
    return

  record.child.kill('SIGTERM')
  await new Promise<void>((resolvePromise) => {
    const timeout = setTimeout(() => {
      if (record.child.exitCode === null)
        record.child.kill('SIGKILL')
    }, 5000)

    record.child.once('close', () => {
      clearTimeout(timeout)
      resolvePromise()
    })
  })
}

export function getManagedProcess(feature: string, provider: string, rootDir: string): ManagedProcessHandle | undefined {
  const record = getManagedProcessRegistry().get(getManagedProcessId(feature, provider, rootDir))
  if (!record)
    return undefined

  return {
    id: record.id,
    ready: record.ready,
    stop: record.stop,
  }
}

export function stopManagedProcess(feature: string, provider: string, rootDir: string) {
  const registry = getManagedProcessRegistry()
  const id = getManagedProcessId(feature, provider, rootDir)
  const record = registry.get(id)
  if (!record)
    return Promise.resolve()

  registry.delete(id)
  return stopRecord(record)
}

export function ensureManagedProcess(options: EnsureManagedProcessOptions): ManagedProcessHandle {
  const registry = getManagedProcessRegistry()
  const id = getManagedProcessId(options.feature, options.provider, options.rootDir)
  const existing = registry.get(id)
  if (existing && existing.child.exitCode === null) {
    return {
      id: existing.id,
      ready: existing.ready,
      stop: existing.stop,
    }
  }

  const child = spawn(options.command, options.args || [], {
    cwd: options.cwd || options.rootDir,
    env: {
      ...process.env,
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  let readyResolved = false
  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveReady = () => {
      if (readyResolved)
        return
      readyResolved = true
      resolvePromise()
    }
    rejectReady = (error) => {
      if (readyResolved)
        return
      readyResolved = true
      rejectPromise(error)
    }
  })

  const stdoutBuffer = { value: '' }
  const stderrBuffer = { value: '' }
  let record!: ManagedProcessRecord
  const rejectAndCleanup = (error: Error) => {
    clearTimeout(startTimeout)
    registry.delete(id)
    rejectReady(error)
    if (record)
      void stopRecord(record)
  }
  const startTimeout = setTimeout(async () => {
    rejectAndCleanup(new Error(`[vitehub] Timed out while starting ${options.provider} dev process.`))
  }, options.startTimeoutMs ?? 15000)

  child.stdout.on('data', (chunk) => {
    if (toLines(chunk.toString(), 'stdout', stdoutBuffer, options.onLine, options.isReady))
      resolveReady()
  })
  child.stderr.on('data', (chunk) => {
    if (toLines(chunk.toString(), 'stderr', stderrBuffer, options.onLine, options.isReady))
      resolveReady()
  })

  child.on('error', (error) => {
    rejectAndCleanup(error instanceof Error ? error : new Error(String(error)))
  })
  child.on('close', (code) => {
    clearTimeout(startTimeout)
    registry.delete(id)
    if (!readyResolved) {
      rejectReady(new Error(`[vitehub] ${options.provider} dev process exited before it became ready (code ${code ?? 'unknown'}).`))
    }
  })

  record = {
    id,
    child,
    ready: ready.finally(() => {
      clearTimeout(startTimeout)
    }),
    stopped: false,
    stop: async () => {
      registry.delete(id)
      await stopRecord(record)
    },
  }

  registry.set(id, record)
  return {
    id: record.id,
    ready: record.ready,
    stop: record.stop,
  }
}
