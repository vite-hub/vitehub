import { hasRuntimeType } from "./internal/runtime-type.ts"
import { AsyncLocalStorage } from "node:async_hooks"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { availableMemory, memoryUsage, resourceUsage } from "node:process"

import type {
  RuntimeResourceInspector,
  RuntimeResourceObservation,
  RuntimeResourceScope,
  RuntimeResourceSnapshot,
  RuntimeResourceSupport,
  RuntimeResourceUnit,
} from "./diagnostics.ts"
import { runtimeErrorDiagnostics } from "./error-diagnostics.ts"

type ReadText = (path: string, options?: { signal?: AbortSignal }) => Promise<string>

export interface NodeRuntimeResourceInspectorOptions {
  now?: () => Date
  readText?: ReadText
}

function observation(
  name: string,
  value: number | undefined,
  scope: RuntimeResourceScope,
  source: string,
  unit: RuntimeResourceUnit,
): RuntimeResourceObservation[] {
  return value === undefined || !Number.isFinite(value) ? [] : [{ name, scope, source, unit, value }]
}

type TextReadResult = { error?: unknown, value?: string }

async function readResult(readText: ReadText, path: string, signal?: AbortSignal): Promise<TextReadResult> {
  try {
    return { value: await readText(path, { signal }) }
  }
  catch (error) {
    return { error }
  }
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || !hasRuntimeType(error, "object")) return
  try {
    // SAFETY: Runtime host normalization establishes the asserted provider contract.
    return hasRuntimeType((error as { code?: unknown }).code, "string") ? (error as { code: string }).code : undefined
  }
  catch {
    return
  }
}

function readFailureReason(results: readonly TextReadResult[], missing: string): string {
  const codes = results.flatMap(result => readErrorCode(result.error) || [])
  if (codes.some(code => code === "EACCES" || code === "EPERM")) return "permission-denied"
  if (codes.length && codes.every(code => code === "ENOENT" || code === "ENOTDIR")) return missing
  return "collection-failed"
}

function mountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
}

export function resolveLinuxCgroupV2Path(mountinfo: string, membership: string): string | undefined {
  const mounts = mountinfo.trim().split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/)
    const separator = fields.indexOf("-")
    if (separator < 6 || fields[separator + 1] !== "cgroup2") return []
    const root = mountInfoPath(fields[3]!)
    const mountPoint = mountInfoPath(fields[4]!)
    if (membership !== root && root !== "/" && !membership.startsWith(`${root}/`)) return []
    return [{ mountPoint, root }]
  }).sort((left, right) => right.root.length - left.root.length)
  const mount = mounts[0]
  if (!mount) return
  const relative = mount.root === "/" ? membership : membership.slice(mount.root.length)
  return join(mount.mountPoint, relative.replace(/^\/+/, ""))
}

function numericFile(value: string | undefined): number | undefined {
  if (!value || value.trim() === "max") return
  const result = Number(value.trim())
  return Number.isFinite(result) ? result : undefined
}

function pairs(value: string | undefined): Record<string, number> {
  return Object.fromEntries((value || "").trim().split("\n").flatMap((line) => {
    const [key, raw] = line.trim().split(/\s+/, 2)
    const count = Number(raw)
    return key && Number.isFinite(count) ? [[key, count]] : []
  }))
}

function meminfo(value: string | undefined): Record<string, number> {
  return Object.fromEntries((value || "").trim().split("\n").flatMap((line) => {
    const match = /^(\w+):\s+(\d+)\s+kB$/.exec(line)
    return match ? [[match[1]!, Number(match[2]) * 1_024]] : []
  }))
}

async function cgroupObservations(readText: ReadText, signal?: AbortSignal): Promise<{
  observations: RuntimeResourceObservation[]
  support: RuntimeResourceSupport
}> {
  const membershipRead = await readResult(readText, "/proc/self/cgroup", signal)
  if (membershipRead.value === undefined) {
    return { observations: [], support: { reason: readFailureReason([membershipRead], "unsupported-runtime"), scope: "service", source: "linux-cgroup-v2", supported: false } }
  }
  const relative = membershipRead.value.split("\n").find(line => line.startsWith("0::"))?.slice(3)
  if (relative === undefined) {
    return { observations: [], support: { reason: "unsupported-runtime", scope: "service", source: "linux-cgroup-v2", supported: false } }
  }
  const mountinfoRead = await readResult(readText, "/proc/self/mountinfo", signal)
  if (mountinfoRead.value === undefined) {
    return { observations: [], support: { reason: readFailureReason([mountinfoRead], "mount-unavailable"), scope: "service", source: "linux-cgroup-v2", supported: false } }
  }
  const root = resolveLinuxCgroupV2Path(mountinfoRead.value, relative)
  if (!root) {
    return { observations: [], support: { reason: "mount-unavailable", scope: "service", source: "linux-cgroup-v2", supported: false } }
  }
  const reads = await Promise.all([
    readResult(readText, join(root, "memory.current"), signal),
    readResult(readText, join(root, "memory.peak"), signal),
    readResult(readText, join(root, "memory.high"), signal),
    readResult(readText, join(root, "memory.max"), signal),
    readResult(readText, join(root, "memory.swap.current"), signal),
    readResult(readText, join(root, "memory.swap.peak"), signal),
    readResult(readText, join(root, "memory.events"), signal),
    readResult(readText, join(root, "cpu.stat"), signal),
  ])
  const [current, peak, high, max, swapCurrent, swapPeak, events, cpu] = reads.map(result => result.value)
  if (current === undefined && events === undefined && cpu === undefined) {
    return { observations: [], support: { reason: readFailureReason(reads, "interfaces-unavailable"), scope: "service", source: "linux-cgroup-v2", supported: false } }
  }
  const memoryEvents = pairs(events)
  const cpuValues = pairs(cpu)
  return {
    observations: [
      ...observation("memory.current", numericFile(current), "service", "linux-cgroup-v2", "bytes"),
      ...observation("memory.peak", numericFile(peak), "service", "linux-cgroup-v2", "bytes"),
      ...observation("memory.high", numericFile(high), "service", "linux-cgroup-v2", "bytes"),
      ...observation("memory.max", numericFile(max), "service", "linux-cgroup-v2", "bytes"),
      ...observation("memory.swap.current", numericFile(swapCurrent), "service", "linux-cgroup-v2", "bytes"),
      ...observation("memory.swap.peak", numericFile(swapPeak), "service", "linux-cgroup-v2", "bytes"),
      ...observation("memory.events.high", memoryEvents.high, "service", "linux-cgroup-v2", "count"),
      ...observation("memory.events.max", memoryEvents.max, "service", "linux-cgroup-v2", "count"),
      ...observation("memory.events.oom", memoryEvents.oom, "service", "linux-cgroup-v2", "count"),
      ...observation("memory.events.oom_kill", memoryEvents.oom_kill, "service", "linux-cgroup-v2", "count"),
      ...observation("cpu.usage", cpuValues.usage_usec, "service", "linux-cgroup-v2", "microseconds"),
    ],
    support: { scope: "service", source: "linux-cgroup-v2", supported: true },
  }
}

export function nodeRuntimeResources(options: NodeRuntimeResourceInspectorOptions = {}): RuntimeResourceInspector {
  const now = options.now || (() => new Date())
  const readText = options.readText || (async (path, readOptions) => await readFile(path, { encoding: "utf8", signal: readOptions?.signal }))
  return {
    async inspect(inspectOptions): Promise<RuntimeResourceSnapshot> {
      const memory = memoryUsage()
      const usage = resourceUsage()
      const linux = process.platform === "linux"
      const [cgroup, linuxMeminfo] = linux
        ? await Promise.all([cgroupObservations(readText, inspectOptions?.signal), readResult(readText, "/proc/meminfo", inspectOptions?.signal)])
        // SAFETY: Runtime host normalization establishes the asserted provider contract.
        : [{ observations: [], support: { reason: "unsupported-runtime", scope: "service", source: "linux-cgroup-v2", supported: false } as const }, {}] as const
      const host = meminfo(linuxMeminfo.value)
      return {
        observedAt: now().toISOString(),
        observations: [
          ...observation("memory.rss", memory.rss, "process", "node", "bytes"),
          ...observation("memory.heap.total", memory.heapTotal, "process", "node", "bytes"),
          ...observation("memory.heap.used", memory.heapUsed, "process", "node", "bytes"),
          ...observation("memory.external", memory.external, "process", "node", "bytes"),
          ...observation("memory.array_buffers", memory.arrayBuffers, "process", "node", "bytes"),
          ...observation("memory.max_rss", usage.maxRSS * 1_024, "process", "node", "bytes"),
          ...observation("cpu.user", usage.userCPUTime, "process", "node", "microseconds"),
          ...observation("cpu.system", usage.systemCPUTime, "process", "node", "microseconds"),
          ...observation("memory.available", availableMemory(), "process", "node", "bytes"),
          ...observation("memory.available", host.MemAvailable, "host", "linux-proc", "bytes"),
          ...observation("memory.swap.free", host.SwapFree, "host", "linux-proc", "bytes"),
          ...cgroup.observations,
        ],
        support: [
          { scope: "process", source: "node", supported: true },
          {
            // SAFETY: Runtime host normalization establishes the asserted provider contract.
            ...(linuxMeminfo.value === undefined
              ? { reason: linux ? readFailureReason([linuxMeminfo], "unsupported-runtime") : "unsupported-runtime" as const }
              : {}),
            scope: "host",
            source: "linux-proc",
            supported: linuxMeminfo.value !== undefined,
          },
          cgroup.support,
        ],
      }
    },
  }
}

export type ProcessReconcilerStatus = "accepting" | "drained" | "draining" | "failed"
export type ProcessReconcilerSignal = Exclude<NodeJS.Signals, "SIGKILL" | "SIGSTOP">

export interface ProcessReconcilerRunContext {
  track<T>(work: Promise<T>): Promise<T>
}

export interface ProcessReconcilerOptions {
  intervalMs: number
  onDrained?: () => Promise<void> | void
  onError?: (error: unknown, reason: string) => Promise<void> | void
  onQuiesce?: () => Promise<void> | void
  repairReason?: string
  run: (reason: string, context: ProcessReconcilerRunContext) => Promise<void> | void
  signal?: false | ProcessReconcilerSignal
}

export interface ProcessReconciler extends ProcessReconcilerRunContext {
  close: () => Promise<void>
  drain: () => Promise<void>
  status: () => ProcessReconcilerStatus
  wake: (reason: string) => void
}

export function createProcessReconciler(options: ProcessReconcilerOptions): ProcessReconciler {
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 1 || options.intervalMs > 2_147_483_647) {
    throw runtimeErrorDiagnostics.RUNTIME_R0009({ message: "Process reconciler intervalMs must be between 1 and 2,147,483,647 milliseconds." })
  }
  const configuredSignal: string | false | undefined = options.signal
  if (configuredSignal === "SIGKILL" || configuredSignal === "SIGSTOP") {
    throw runtimeErrorDiagnostics.RUNTIME_R0010({ message: `Process reconciler signal ${configuredSignal} cannot be handled.` })
  }

  let closed = false
  let drainPromise: Promise<void> | undefined
  let queued = false
  let reason = "coalesced"
  let rerun = false
  let running: Promise<void> | undefined
  let status: ProcessReconcilerStatus = "accepting"
  let timer: NodeJS.Timeout | undefined
  const activeCallbacks = new Set<object>()
  const callbackContext = new AsyncLocalStorage<object>()
  const settlements = new Map<Promise<unknown>, Promise<PromiseSettledResult<unknown>>>()

  const invokeCallback = async <T>(callback: () => Promise<T> | T): Promise<T> => {
    const token = {}
    activeCallbacks.add(token)
    try {
      return await callbackContext.run(token, callback)
    }
    finally {
      activeCallbacks.delete(token)
    }
  }

  const track: ProcessReconcilerRunContext["track"] = (work) => {
    const promise = Promise.resolve(work)
    if (status === "drained" || status === "failed") return promise
    const settlement = promise.then(
      (value): PromiseSettledResult<unknown> => ({ status: "fulfilled", value }),
      (reason): PromiseSettledResult<unknown> => ({ reason, status: "rejected" }),
    )
    settlements.set(promise, settlement)
    void settlement.then(() => {
      if (status === "accepting") settlements.delete(promise)
    })
    return promise
  }

  const scheduleRepair = () => {
    if (closed || timer) return
    timer = setTimeout(() => {
      timer = undefined
      wake(options.repairReason || "repair")
    }, options.intervalMs)
    timer.unref?.()
  }

  const execute = async (): Promise<void> => {
    queued = false
    if (running) {
      rerun = true
      return await running
    }
    let resolveActive!: () => void
    let rejectActive!: (error: unknown) => void
    const active = new Promise<void>((resolve, reject) => {
      resolveActive = resolve
      rejectActive = reject
    })
    running = active
    const runAdmitted = async (): Promise<void> => {
      let failure: unknown
      let hasFailure = false
      do {
        rerun = false
        const currentReason = reason
        reason = "coalesced"
        try {
          await invokeCallback(() => options.run(currentReason, { track }))
        }
        catch (error) {
          if (options.onError) {
            try {
              await invokeCallback(() => options.onError!(error, currentReason))
            }
            catch (reportingError) {
              if (!hasFailure) {
                failure = reportingError
                hasFailure = true
              }
            }
          }
        }
      } while (rerun)
      if (hasFailure) throw failure
    }
    const complete = (failure?: unknown, hasFailure = false): void => {
      if (rerun) {
        void runAdmitted().then(
          () => complete(failure, hasFailure),
          error => complete(hasFailure ? failure : error, true),
        )
        return
      }
      running = undefined
      scheduleRepair()
      if (hasFailure) rejectActive(failure)
      else resolveActive()
    }
    void runAdmitted().then(
      () => complete(),
      error => complete(error, true),
    )
    await active
  }

  const wake = (nextReason: string) => {
    if (closed) return
    reason = nextReason
    if (timer) clearTimeout(timer)
    timer = undefined
    if (running) {
      rerun = true
      return
    }
    if (queued) return
    queued = true
    queueMicrotask(() => void execute().catch(() => {}))
  }

  const drain = (): Promise<void> => {
    const caller = callbackContext.getStore()
    if (caller && activeCallbacks.has(caller)) {
      return Promise.reject(runtimeErrorDiagnostics.RUNTIME_R0011({ message: "Process reconciler callbacks cannot call drain() while active." }))
    }
    if (drainPromise) return drainPromise
    drainPromise = (async () => {
      let failure: unknown
      let hasFailure = false
      const retainFailure = (error: unknown) => {
        if (hasFailure) return
        failure = error
        hasFailure = true
      }
      const settleTrackedWork = async (final: boolean): Promise<void> => {
        while (true) {
          if (settlements.size === 0) {
            if (final) status = hasFailure ? "failed" : "drained"
            return
          }
          const batch = [...settlements.entries()]
          const results = await Promise.all(batch.map(([, settlement]) => settlement))
          for (const [promise] of batch) settlements.delete(promise)
          const rejected = results.find(result => result.status === "rejected")
          if (rejected) retainFailure(rejected.reason)
        }
      }

      status = "draining"
      closed = true
      if (queued && !running) await Promise.resolve()
      const admittedRun = running
      if (timer) clearTimeout(timer)
      timer = undefined
      try {
        if (options.onQuiesce) await invokeCallback(options.onQuiesce)
      }
      catch (error) {
        retainFailure(error)
      }
      try {
        await admittedRun
      }
      catch (error) {
        retainFailure(error)
      }
      await settleTrackedWork(false)
      if (!hasFailure && options.onDrained) {
        try {
          await invokeCallback(options.onDrained)
          await new Promise<void>(resolve => setImmediate(resolve))
        }
        catch (error) {
          retainFailure(error)
        }
      }
      await settleTrackedWork(true)
      if (hasFailure) throw failure
    })()
    return drainPromise
  }

  const signal = options.signal === false ? undefined : options.signal
  const listener = signal
    ? () => {
        void drain().catch(async (error) => {
          try {
            await options.onError?.(error, "drain")
          }
          catch {}
        })
      }
    : undefined
  if (signal && listener) process.on(signal, listener)
  scheduleRepair()

  return {
    async close() {
      await drain()
      if (signal && listener) process.off(signal, listener)
    },
    drain,
    status: () => status,
    track,
    wake,
  }
}
