import { readFile, stat } from "node:fs/promises"
import { posix } from "node:path"

import { resolveLinuxCgroupV2Path } from "@vite-hub/runtime/internal/node"

import { shareAgentCapacityOptions } from "../internal/agent-capacity.ts"

import type { AgentDriverCapacityOptions, AgentDriverCapacityQueueOptions, AgentDriverCapacitySample, AgentDriverCapacitySampleContext } from "../types.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { isRuntimeRecord } from "../internal/runtime-type.ts"

export interface ProcessAgentCapacityOptions {
  concurrency: number
  cpu?: {
    /** Pause new admissions above this CPU pressure. Defaults to 0.25. */
    pausePressure?: number
    /**
     * Resume when CPU pressure falls to this much above the lowest pressure of the last 10 minutes, the host's idle
     * pressure, and no higher than `pausePressure`. Use this value alone until sampling covers 10 minutes, including
     * after a sampling gap of 10 minutes or more. Defaults to 0.1.
     */
    resumePressure?: number
  }
  fallbackConcurrency?: number
  intervalMs?: number
  memory?: {
    /** Pause new admissions above this memory pressure. Defaults to 0.05. */
    pausePressure?: number
    /** Reserve this much future growth for every active invocation as well as new work. */
    perInvocationBytes?: number
    /** Memory reserved for other services on the host. */
    reserveBytes?: number
    /** Memory reserved inside the process/service budget. Defaults to 1 GiB. */
    serviceReserveBytes?: number
    /**
     * Resume when memory pressure falls to this much above the lowest pressure of the last 10 minutes, the host's idle
     * pressure, and no higher than `pausePressure`. Use this value alone until sampling covers 10 minutes, including
     * after a sampling gap of 10 minutes or more. Defaults to 0.01.
     */
    resumePressure?: number
  }
  queue?: AgentDriverCapacityQueueOptions
  rampUp?: number
  /**
   * Invocations that run on other hosts and do not take this queue. They count toward concurrency but
   * reserve no local memory.
   */
  remoteActive?: () => number
  sampleTimeoutMs?: number
  sample?: (context: AgentDriverCapacitySampleContext) => AgentDriverCapacitySample | Promise<AgentDriverCapacitySample>
}

interface PressurePolicy {
  pausePressure: number
  resumePressure: number
}

interface ProcessResourceSample {
  cgroupAvailable: boolean
  hostAvailableMemory: number
  availableMemory: number
  cpuPressure: number
  memoryCurrent: number
  memoryHigh: number
  memoryHighEvents: number
  memoryMax: number
  memoryPressure: number
  /** Inactive page cache in the limiting cgroup. The kernel reclaims it before stalling workers. */
  memoryReclaimable: number
}

export function createProcessAgentCapacity(options: ProcessAgentCapacityOptions): AgentDriverCapacityOptions {
  if (!options || !Number.isInteger(options.concurrency) || options.concurrency <= 0) {
    throw agentDiagnostics.AGENT_R0732({ message: "[vitehub] createProcessAgentCapacity({ concurrency }) must be a positive integer." })
  }
  const fallbackConcurrency = options.fallbackConcurrency ?? 1
  const intervalMs = options.intervalMs ?? 5_000
  const rampUp = options.rampUp ?? 1
  const sampleTimeoutMs = options.sampleTimeoutMs ?? 1_000
  if (!Number.isInteger(fallbackConcurrency) || fallbackConcurrency < 0 || fallbackConcurrency > options.concurrency) {
    throw agentDiagnostics.AGENT_R0733({ message: "[vitehub] createProcessAgentCapacity({ fallbackConcurrency }) must be an integer between zero and concurrency." })
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 100 || intervalMs > 2_147_483_647) {
    throw agentDiagnostics.AGENT_R0734({ message: "[vitehub] createProcessAgentCapacity({ intervalMs }) must be a finite number between 100 and 2147483647." })
  }
  if (!Number.isInteger(rampUp) || rampUp <= 0) {
    throw agentDiagnostics.AGENT_R0735({ message: "[vitehub] createProcessAgentCapacity({ rampUp }) must be a positive integer." })
  }
  if (!Number.isFinite(sampleTimeoutMs) || sampleTimeoutMs <= 0 || sampleTimeoutMs > 2_147_483_647) {
    throw agentDiagnostics.AGENT_R0736({ message: "[vitehub] createProcessAgentCapacity({ sampleTimeoutMs }) must be a positive finite number no greater than 2147483647." })
  }

  const cpu = {
    pausePressure: options.cpu?.pausePressure ?? 0.25,
    resumePressure: options.cpu?.resumePressure ?? 0.1,
  }
  const memory = {
    pausePressure: options.memory?.pausePressure ?? 0.05,
    perInvocationBytes: options.memory?.perInvocationBytes ?? 1024 ** 3,
    reserveBytes: options.memory?.reserveBytes ?? 1024 ** 3,
    serviceReserveBytes: options.memory?.serviceReserveBytes ?? 1024 ** 3,
    resumePressure: options.memory?.resumePressure ?? 0.01,
  }
  assertPressurePolicy(cpu, "cpu")
  assertPressurePolicy(memory, "memory")
  if (!Number.isFinite(memory.perInvocationBytes) || memory.perInvocationBytes <= 0) {
    throw agentDiagnostics.AGENT_R0737({ message: "[vitehub] createProcessAgentCapacity({ memory.perInvocationBytes }) must be a positive finite number." })
  }
  if (!Number.isFinite(memory.reserveBytes) || memory.reserveBytes < 0) {
    throw agentDiagnostics.AGENT_R0738({ message: "[vitehub] createProcessAgentCapacity({ memory.reserveBytes }) must be a non-negative finite number." })
  }
  if (!Number.isFinite(memory.serviceReserveBytes) || memory.serviceReserveBytes < 0) {
    throw agentDiagnostics.AGENT_R0738({ message: "[vitehub] createProcessAgentCapacity({ memory.serviceReserveBytes }) must be a non-negative finite number." })
  }
  if (options.sample !== undefined && typeof options.sample !== "function") {
    throw agentDiagnostics.AGENT_R0739({ message: "[vitehub] createProcessAgentCapacity({ sample }) must be a function." })
  }

  let pressurePaused = false
  let lastMemoryHighEvents: number | undefined
  const idlePressure = createIdlePressure(idlePressureWindowMs)
  const sample =
    options.sample ??
    (async (context: AgentDriverCapacitySampleContext): Promise<AgentDriverCapacitySample> => {
      const resources = await readProcessResources(context.signal)
      // memory.high also fires while the kernel trims page cache from checkouts and installs.
      // Treat it as pressure only once the cgroup has no worker's worth of cache left to reclaim.
      const memoryHighIncreased =
        lastMemoryHighEvents !== undefined &&
        resources.memoryHighEvents > lastMemoryHighEvents &&
        resources.memoryReclaimable < memory.perInvocationBytes
      if (resources.cgroupAvailable) lastMemoryHighEvents = resources.memoryHighEvents

      const floor = idlePressure.record(resources.cpuPressure, resources.memoryPressure)
      if (pressurePaused) {
        pressurePaused =
          memoryHighIncreased ||
          resources.cpuPressure > resumeThreshold(cpu, floor.cpu) ||
          resources.memoryPressure > resumeThreshold(memory, floor.memory)
      } else {
        pressurePaused =
          resources.cpuPressure > cpu.pausePressure || resources.memoryPressure > memory.pausePressure || memoryHighIncreased
      }
      if (pressurePaused) {
        return {
          concurrency: 0,
          reason: memoryHighIncreased
            ? "memory.high event"
            : `resource pressure (cpu=${formatPressure(resources.cpuPressure)}, memory=${formatPressure(resources.memoryPressure)})`,
        }
      }

      const limit = Math.min(resources.memoryHigh, resources.memoryMax)
      const workingSet = Math.max(0, resources.memoryCurrent - resources.memoryReclaimable)
      const cgroupAvailableMemory = Number.isFinite(limit) ? Math.max(0, limit - workingSet) : Number.POSITIVE_INFINITY
      const availableMemory = Math.min(resources.hostAvailableMemory, resources.availableMemory, cgroupAvailableMemory)
      const admissionMemory = Math.min(
        resources.hostAvailableMemory - memory.reserveBytes,
        Math.min(resources.availableMemory, cgroupAvailableMemory) - memory.serviceReserveBytes,
      )
      const remoteActive = options.remoteActive?.()
      // Runtime configuration is untyped at this boundary. Invalid remote
      // counts must not poison admission arithmetic or trigger adaptive
      // fallback; treat them as no remote work.
      const validRemoteActive = typeof remoteActive === "number" && Number.isFinite(remoteActive) && remoteActive >= 0
        ? remoteActive
        : 0
      // Remote invocations do not take this queue, so every active invocation is local. Remote ones
      // still hold concurrency slots.
      const additional = Math.max(0, Math.floor((admissionMemory - context.active * memory.perInvocationBytes) / memory.perInvocationBytes))
      const memoryConcurrency = context.active + additional
      const concurrency = Math.max(0, Math.min(context.concurrency - validRemoteActive, memoryConcurrency))
      return concurrency > context.active
        ? { concurrency, reason: `capacity available (${formatBytes(availableMemory)} memory headroom)` }
        : { concurrency, reason: `waiting for capacity (${formatBytes(availableMemory)} memory headroom)` }
    })

  return shareAgentCapacityOptions({
    adaptive: { fallbackConcurrency, intervalMs, rampUp, sample, sampleTimeoutMs },
    concurrency: options.concurrency,
    ...(options.queue ? { queue: options.queue } : {}),
  })
}

/** How far back the idle pressure of the host looks. */
const idlePressureWindowMs = 10 * 60_000

/**
 * The lowest CPU and memory pressure of the last `windowMs`. A shared host never drops below the load of its other
 * services. It is zero until the samples cover the whole window, so a short dip after a pause does not count as idle.
 */
function createIdlePressure(windowMs: number): { record(cpu: number, memory: number): { cpu: number, memory: number } } {
  const samples: { at: number, cpu: number, memory: number }[] = []
  return {
    record(cpu, memory) {
      const now = performance.now()
      const cutoff = now - windowMs
      const previous = samples.at(-1)
      if (previous && previous.at <= cutoff) samples.length = 0
      samples.push({ at: now, cpu, memory })
      // Keep one sample at or before the start of the window, so the samples show when they cover all of it.
      while (samples.length > 1 && samples[1]!.at <= cutoff) samples.shift()
      if (samples[0]!.at > cutoff) return { cpu: 0, memory: 0 }
      for (const entry of samples) {
        if (entry.at < cutoff) continue
        cpu = Math.min(cpu, entry.cpu)
        memory = Math.min(memory, entry.memory)
      }
      return { cpu, memory }
    },
  }
}

/** Resume at `resumePressure` above the idle pressure of the host, and never above `pausePressure`. */
function resumeThreshold(policy: PressurePolicy, idle: number): number {
  return Math.min(policy.pausePressure, idle + policy.resumePressure)
}

function assertPressurePolicy(value: PressurePolicy, name: "cpu" | "memory"): void {
  if (!Number.isFinite(value.pausePressure) || value.pausePressure < 0 || value.pausePressure > 1) {
    throw agentDiagnostics.AGENT_R0740({ message: `[vitehub] createProcessAgentCapacity({ ${name}.pausePressure }) must be between zero and one.` })
  }
  if (!Number.isFinite(value.resumePressure) || value.resumePressure < 0 || value.resumePressure > value.pausePressure) {
    throw agentDiagnostics.AGENT_R0741({ message: `[vitehub] createProcessAgentCapacity({ ${name}.resumePressure }) must be between zero and pausePressure.` })
  }
}

async function readProcessResources(signal: AbortSignal): Promise<ProcessResourceSample> {
  const [cgroup, meminfo, cpu, memory] = await Promise.all([
    readCgroupResources(signal),
    readOptionalCgroupFile("/proc/meminfo", signal),
    readOptionalCgroupFile("/proc/pressure/cpu", signal),
    readOptionalCgroupFile("/proc/pressure/memory", signal),
  ])
  const hostAvailable = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo ?? "")
  // libuv subtracts the process cgroup's memory.current, page cache included.
  const nodeAvailable = process.availableMemory() + (cgroup?.ownReclaimable ?? 0)
  return {
    cgroupAvailable: cgroup !== undefined,
    availableMemory: nodeAvailable,
    hostAvailableMemory: hostAvailable ? Number(hostAvailable[1]) * 1024 : nodeAvailable,
    cpuPressure: Math.max(cgroup?.cpuPressure ?? 0, parsePressure(cpu ?? "")),
    memoryCurrent: cgroup?.memoryCurrent ?? 0,
    memoryHigh: cgroup?.memoryHigh ?? Number.POSITIVE_INFINITY,
    memoryHighEvents: cgroup?.memoryHighEvents ?? 0,
    memoryMax: cgroup?.memoryMax ?? Number.POSITIVE_INFINITY,
    memoryPressure: Math.max(cgroup?.memoryPressure ?? 0, parsePressure(memory ?? "")),
    memoryReclaimable: cgroup?.memoryReclaimable ?? 0,
  }
}

async function readCgroupResources(signal: AbortSignal): Promise<(Omit<ProcessResourceSample, "availableMemory" | "cgroupAvailable" | "hostAvailableMemory"> & { ownReclaimable: number }) | undefined> {
  const membership = await readOptionalCgroupFile("/proc/self/cgroup", signal)
  const relative = membership?.split(/\r?\n/).find((line) => line.startsWith("0::"))?.slice(3)
  if (relative === undefined) return
  const mountinfo = await readOptionalCgroupFile("/proc/self/mountinfo", signal)
  if (mountinfo === undefined) return
  const roots: { path: string, rootCandidate: boolean }[] = []
  // Resolve each visible ancestor through the mount mapping. Never read above a namespaced mount.
  for (let member = relative; ; member = posix.dirname(member)) {
    const root = resolveLinuxCgroupV2Path(mountinfo, member)
    if (root === undefined) break
    roots.push({ path: root, rootCandidate: member === "/" })
    if (member === "/") break
  }
  const groups = await Promise.all(roots.map(async ({ path: root, rootCandidate }) => {
    const [current, high, max, events, stat, cpuPressure, memoryPressure] = await Promise.all([
      readCgroupMemoryFile(`${root}/memory.current`, signal, rootCandidate),
      readCgroupMemoryFile(`${root}/memory.high`, signal, rootCandidate),
      readCgroupMemoryFile(`${root}/memory.max`, signal, rootCandidate),
      readCgroupMemoryFile(`${root}/memory.events`, signal, rootCandidate),
      readOptionalCgroupFile(`${root}/memory.stat`, signal),
      readOptionalCgroupFile(`${root}/cpu.pressure`, signal),
      readOptionalCgroupFile(`${root}/memory.pressure`, signal),
    ])
    const memoryCurrent = current === undefined ? 0 : parseCgroupNumber(current)
    const memoryHigh = high === undefined ? Infinity : parseLimit(high)
    const memoryHighEvents = parseEvent(events ?? "", "high")
    const memoryMax = max === undefined ? Infinity : parseLimit(max)
    const memoryReclaimable = parseEvent(stat ?? "", "inactive_file")
    if (memoryCurrent === undefined || memoryHigh === undefined || memoryHighEvents === undefined || memoryMax === undefined || memoryReclaimable === undefined) return
    return {
      cpuPressure: parsePressure(cpuPressure ?? ""),
      memoryCurrent,
      memoryHigh,
      memoryHighEvents,
      memoryMax,
      memoryPressure: parsePressure(memoryPressure ?? ""),
      memoryReclaimable,
    }
  }))
  // A cgroup file that does not hold a number skips the cgroup limits.
  if (!groups.every(group => group !== undefined)) return
  let limiting = groups[0]
  if (!limiting) return
  const ownReclaimable = limiting.memoryReclaimable
  // Same working set as the kubelet: memory.current minus inactive page cache.
  const headroom = (group: typeof limiting) => Math.min(group.memoryHigh, group.memoryMax) - (group.memoryCurrent - group.memoryReclaimable)
  for (const group of groups) if (headroom(group) < headroom(limiting)) limiting = group
  return {
    ...limiting,
    ownReclaimable,
    cpuPressure: Math.max(...groups.map(group => group.cpuPressure)),
    memoryHighEvents: groups.reduce((sum, group) => sum + group.memoryHighEvents, 0),
    memoryPressure: Math.max(...groups.map(group => group.memoryPressure)),
  }
}

// Only the actual hierarchy root may omit memory controller files. A cgroup namespace
// can also expose a delegated cgroup as `/`; kernfs inode 1 identifies the real root.
async function readCgroupMemoryFile(path: string, signal: AbortSignal, rootCandidate: boolean): Promise<string | undefined> {
  try { return await readFile(path, { encoding: "utf8", signal }) }
  catch (error) {
    if (rootCandidate && !signal.aborted && isRuntimeRecord(error) && error.code === "ENOENT") {
      const directory = await stat(posix.dirname(path))
      if (!signal.aborted && directory.ino === 1) return
    }
    throw error
  }
}

async function readOptionalCgroupFile(path: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    return await readFile(path, { encoding: "utf8", signal })
  } catch (error) {
    if (signal.aborted) throw error
    return undefined
  }
}

function parseEvent(value: string, name: string): number | undefined {
  const line = value.split(/\r?\n/).find((entry) => entry.startsWith(`${name} `))
  return line ? parseCgroupNumber(line.slice(name.length + 1)) : 0
}

function parseLimit(value: string): number | undefined {
  const parsed = value.trim()
  return parsed === "max" ? Number.POSITIVE_INFINITY : parseCgroupNumber(parsed)
}

/** The number in a cgroup file, or `undefined` when the file does not hold a whole number. */
function parseCgroupNumber(value: string): number | undefined {
  const parsed = value.trim()
  const number = Number(parsed)
  return /^\d+$/.test(parsed) && Number.isFinite(number) ? number : undefined
}

function parsePressure(value: string): number {
  const match = /^some\s+.*?avg10=([\d.]+)/m.exec(value)
  return match ? Number(match[1]) / 100 : 0
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return "unlimited"
  return `${(value / 1024 ** 3).toFixed(1)} GiB`
}

function formatPressure(value: number): string {
  return `${Math.round(value * 100)}%`
}

/** Recover invocations owned by this host before admitting new work. */
export async function createProcessAgentInvocations(
  options: import("../invocations.ts").AgentInvocationsOptions & {
    recovery: Parameters<typeof import("../server/invocation-health.ts").failInterruptedAgentInvocations>[1]
  },
): Promise<import("../invocations.ts").AgentInvocations> {
  const { defineAgentInvocations, recoverInterruptedAgentInvocations } = await import("../invocations.ts")
  const invocations = defineAgentInvocations(options)
  await recoverInterruptedAgentInvocations(invocations, options.recovery)
  return invocations
}

export { createProcessAgentHost } from './process-host.ts'
export type { ProcessAgentHost, ProcessAgentHostOptions } from './process-host.ts'

/**
 * Starts the process hosts that discovered Agents contribute, for example through a process host
 * preset. The generated Nitro plugin owns one instance per server process.
 *
 * With `leases`, each Agent runs its host on one server at a time, under the Lease `agent-process-host:<agent>`.
 * The other servers wait and take over within about 30 seconds when the holder stops.
 */
export function createAgentProcessHosts(options: {
  names: readonly string[]
  registry: import("../types.ts").AgentRegistry
  state: () => { extension(name: string): import("../state/sqlite.ts").SqliteAgentStateExtension }
  dataDir?: string
  /** Defaults to starting only when NODE_ENV is production or VITEHUB_AGENT_PROCESS_HOSTS is "1". */
  enabled?: boolean
  /** First delay before a host that failed to start is created again. Doubles up to 30 minutes. Defaults to 1 minute. */
  retryMs?: number
  /** A shared Lease store, such as `useLeases()`. Without it, every server runs every host. */
  leases?: () => import("@vite-hub/runtime").LeaseStore
  /** Lease timing, for tests. Defaults to a 25 second Lease that each server checks every 5 seconds. */
  lease?: { ttlMs?: number, intervalMs?: number }
}): {
  start(): void
  close(): Promise<void>
  wake(reason?: string): void
  status(): "starting" | "accepting" | "draining" | "drained" | "failed"
  health(): Promise<{ status: "healthy" | "degraded", agents: Record<string, unknown> }>
} {
  const hosts = new Map<string, import("../process-host.ts").AgentProcessHostInstance>()
  const failures = new Map<string, string>()
  const gates = new Map<string, import("./process-host-lease.ts").AgentProcessHostLease>()
  let starting: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let drained = false
  // A development server with production credentials must not repair real PRs by accident.
  const enabled = options.enabled ?? (process.env.NODE_ENV === "production" || process.env.VITEHUB_AGENT_PROCESS_HOSTS === "1")
  const retries = new Map<string, ReturnType<typeof setTimeout>>()
  const retryMs = options.retryMs ?? 60_000
  const startHost = async (agentName: string, attempt: number, canStart?: () => boolean): Promise<boolean> => {
    retries.delete(agentName)
    if (closing) return false
    const { loadAgent } = await import("../index.ts")
    const { getAgentProcessHostContribution } = await import("../process-host.ts")
    const { join } = await import("node:path")
    try {
      const agent = await loadAgent(agentName, options.registry)
      if (closing || canStart?.() === false) return false
      const contribution = getAgentProcessHostContribution(agent)
      if (!contribution) {
        failures.set(agentName, "The Agent has no process host contribution.")
        return false
      }
      const host = await contribution.create({ agentName, agent, state: options.state(), dataDir: join(options.dataDir ?? ".vitehub/agents", agentName) })
      if (closing || canStart?.() === false) {
        await host.close()
        return false
      }
      hosts.set(agentName, host)
      host.start()
      failures.delete(agentName)
      return true
    }
    catch (error) {
      failures.set(agentName, error instanceof Error ? error.message : String(error))
      console.error(`[vitehub] Agent process host "${agentName}" did not start.`, error)
      await stopHost(agentName).catch(error => console.error(`[vitehub] Agent process host "${agentName}" did not close.`, error))
      if (canStart || closing) return false
      // A provider outage at boot, such as an unavailable GitHub API, must not stop the host until the next deploy.
      const delay = Math.min(retryMs * 2 ** attempt, 30 * 60_000)
      const timer = setTimeout(() => { void startHost(agentName, attempt + 1) }, delay)
      timer.unref?.()
      retries.set(agentName, timer)
      return false
    }
  }
  const stopHost = async (agentName: string): Promise<void> => {
    const host = hosts.get(agentName)
    hosts.delete(agentName)
    await host?.close()
  }
  const leaseStore = (): import("@vite-hub/runtime").LeaseStore | undefined => {
    if (!options.leases) return undefined
    try {
      return options.leases()
    }
    catch (error) {
      console.warn("[vitehub:agent] Agent process hosts need a Lease store in the default Database. Every server runs its own process hosts.", error)
      return undefined
    }
  }
  return {
    start() {
      if (starting || closing || !enabled) return
      const leases = leaseStore()
      if (!leases) {
        starting = Promise.all(options.names.map(agentName => startHost(agentName, 0))).then(() => undefined)
        return
      }
      starting = import("./process-host-lease.ts").then(({ startAgentProcessHostLease }) => {
        if (closing) return
        for (const agentName of options.names) {
          gates.set(agentName, startAgentProcessHostLease({
            ...options.lease,
            agentName,
            leases,
            state: options.state,
            promote: canStart => startHost(agentName, 0, canStart),
            demote: () => stopHost(agentName),
            onError: error => console.error(`[vitehub] The process host Lease of the Agent "${agentName}" failed.`, error),
          }))
        }
      })
    },
    close() {
      closing ??= (async () => {
        for (const timer of retries.values()) clearTimeout(timer)
        retries.clear()
        await Promise.all([...gates.values()].map(gate => gate.stop()))
        await starting
        await Promise.all([...hosts.keys()].map(stopHost))
        drained = true
      })()
      return closing
    },
    wake(reason) {
      for (const host of hosts.values()) host.wake(reason)
    },
    status() {
      if (!enabled) return "drained"
      if (closing) return drained ? "drained" : "draining"
      const statuses = [...hosts.values()].map(host => host.status())
      for (const name of failures.keys()) {
        const gate = gates.get(name)
        if (gate ? !gate.holder() : !statuses.length) return "failed"
      }
      if (!statuses.length) return gates.size ? "accepting" : "starting"
      for (const status of ["failed", "draining", "starting", "accepting"] as const) if (statuses.includes(status)) return status
      return "drained"
    },
    async health() {
      const agents: Record<string, unknown> = {}
      for (const [name, reason] of failures) agents[name] = { status: "degraded", reason }
      for (const [name, gate] of gates) {
        if (gate.role() !== "standby") continue
        const holder = gate.holder()
        if (!failures.has(name) || holder) agents[name] = { status: "healthy", role: "standby", holder }
        else agents[name] = { status: "degraded", role: "standby", reason: failures.get(name) }
      }
      for (const [name, host] of hosts) agents[name] = { ...await host.health(), ...gates.has(name) ? { role: "holder" } : {} }
      if (enabled && !closing) for (const name of options.names) {
        if (!(name in agents)) agents[name] = { status: "degraded", reason: "Process host is starting." }
      }
      if (!enabled) for (const name of options.names) agents[name] = { status: "degraded", reason: "Process hosts start in production or with VITEHUB_AGENT_PROCESS_HOSTS=1." }
      const degraded = Object.values(agents).some(agent => isRuntimeRecord(agent) && agent.status !== "healthy")
      return { status: degraded ? "degraded" : "healthy", agents }
    },
  }
}
