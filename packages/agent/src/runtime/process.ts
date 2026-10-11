import { readFile } from "node:fs/promises"
import { freemem } from "node:os"

import { resolveLinuxCgroupV2Path } from "@vite-hub/runtime/node"

import { shareAgentCapacityOptions } from "../internal/agent-capacity.ts"

import type { AgentDriverCapacityOptions, AgentDriverCapacityQueueOptions, AgentDriverCapacitySample, AgentDriverCapacitySampleContext } from "../types.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { isRuntimeRecord } from "../internal/runtime-type.ts"

export interface ProcessAgentCapacityOptions {
  concurrency: number
  cpu?: {
    pausePressure?: number
    resumePressure?: number
  }
  fallbackConcurrency?: number
  intervalMs?: number
  memory?: {
    pausePressure?: number
    perInvocationBytes?: number
    reserveBytes?: number
    resumePressure?: number
  }
  queue?: AgentDriverCapacityQueueOptions
  rampUp?: number
  sampleTimeoutMs?: number
  sample?: (context: AgentDriverCapacitySampleContext) => AgentDriverCapacitySample | Promise<AgentDriverCapacitySample>
}

interface PressurePolicy {
  pausePressure: number
  resumePressure: number
}

interface ProcessResourceSample {
  availableMemory: number
  cpuPressure: number
  memoryCurrent: number
  memoryHigh: number
  memoryHighEvents: number
  memoryMax: number
  memoryPressure: number
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
  if (options.sample !== undefined && typeof options.sample !== "function") {
    throw agentDiagnostics.AGENT_R0739({ message: "[vitehub] createProcessAgentCapacity({ sample }) must be a function." })
  }

  let pressurePaused = false
  let lastMemoryHighEvents: number | undefined
  const sample =
    options.sample ??
    (async (context: AgentDriverCapacitySampleContext): Promise<AgentDriverCapacitySample> => {
      const resources = await readProcessResources(context.signal)
      const memoryHighIncreased = lastMemoryHighEvents !== undefined && resources.memoryHighEvents > lastMemoryHighEvents
      lastMemoryHighEvents = resources.memoryHighEvents

      if (pressurePaused) {
        pressurePaused =
          memoryHighIncreased || resources.cpuPressure > cpu.resumePressure || resources.memoryPressure > memory.resumePressure
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
      const cgroupAvailableMemory = Number.isFinite(limit) ? Math.max(0, limit - resources.memoryCurrent) : Number.POSITIVE_INFINITY
      const availableMemory = Math.min(resources.availableMemory, cgroupAvailableMemory)
      const additional = Math.max(0, Math.floor((availableMemory - memory.reserveBytes) / memory.perInvocationBytes))
      const memoryConcurrency = context.active + additional
      const concurrency = Math.max(0, Math.min(context.concurrency, memoryConcurrency))
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

function assertPressurePolicy(value: PressurePolicy, name: "cpu" | "memory"): void {
  if (!Number.isFinite(value.pausePressure) || value.pausePressure < 0 || value.pausePressure > 1) {
    throw agentDiagnostics.AGENT_R0740({ message: `[vitehub] createProcessAgentCapacity({ ${name}.pausePressure }) must be between zero and one.` })
  }
  if (!Number.isFinite(value.resumePressure) || value.resumePressure < 0 || value.resumePressure > value.pausePressure) {
    throw agentDiagnostics.AGENT_R0741({ message: `[vitehub] createProcessAgentCapacity({ ${name}.resumePressure }) must be between zero and pausePressure.` })
  }
}

async function readProcessResources(signal: AbortSignal): Promise<ProcessResourceSample> {
  const cgroup = await readCgroupResources(signal).catch((error) => {
    if (signal.aborted) throw error
    return undefined
  })
  return {
    availableMemory: typeof process.availableMemory === "function" ? process.availableMemory() : freemem(),
    cpuPressure: cgroup?.cpuPressure ?? 0,
    memoryCurrent: cgroup?.memoryCurrent ?? 0,
    memoryHigh: cgroup?.memoryHigh ?? Number.POSITIVE_INFINITY,
    memoryHighEvents: cgroup?.memoryHighEvents ?? 0,
    memoryMax: cgroup?.memoryMax ?? Number.POSITIVE_INFINITY,
    memoryPressure: cgroup?.memoryPressure ?? 0,
  }
}

async function readCgroupResources(signal: AbortSignal): Promise<Omit<ProcessResourceSample, "availableMemory">> {
  const membership = await readFile("/proc/self/cgroup", { encoding: "utf8", signal })
  const relative = membership.split(/\r?\n/).find((line) => line.startsWith("0::"))?.slice(3)
  if (relative === undefined) throw agentDiagnostics.AGENT_R0742({ message: "cgroup v2 membership is unavailable" })
  const mountinfo = await readFile("/proc/self/mountinfo", { encoding: "utf8", signal })
  const root = resolveLinuxCgroupV2Path(mountinfo, relative)
  if (root === undefined) throw agentDiagnostics.AGENT_R0743({ message: "cgroup v2 mount is unavailable" })
  const [current, high, max, events, cpuPressure, memoryPressure] = await Promise.all([
    readFile(`${root}/memory.current`, { encoding: "utf8", signal }),
    readFile(`${root}/memory.high`, { encoding: "utf8", signal }),
    readFile(`${root}/memory.max`, { encoding: "utf8", signal }),
    readFile(`${root}/memory.events`, { encoding: "utf8", signal }),
    readOptionalCgroupFile(`${root}/cpu.pressure`, signal),
    readOptionalCgroupFile(`${root}/memory.pressure`, signal),
  ])
  return {
    cpuPressure: parsePressure(cpuPressure ?? ""),
    memoryCurrent: parseCgroupNumber(current, "memory.current"),
    memoryHigh: parseLimit(high, "memory.high"),
    memoryHighEvents: parseEvent(events, "high"),
    memoryMax: parseLimit(max, "memory.max"),
    memoryPressure: parsePressure(memoryPressure ?? ""),
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

function parseEvent(value: string, name: string): number {
  const line = value.split(/\r?\n/).find((entry) => entry.startsWith(`${name} `))
  return line ? parseCgroupNumber(line.slice(name.length + 1), `memory.events.${name}`) : 0
}

function parseLimit(value: string, name: string): number {
  const parsed = value.trim()
  return parsed === "max" ? Number.POSITIVE_INFINITY : parseCgroupNumber(parsed, name)
}

function parseCgroupNumber(value: string, name: string): number {
  const parsed = Number(value.trim())
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid cgroup ${name} value.`)
  return parsed
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
  const { defineAgentInvocations } = await import("../invocations.ts")
  const { failInterruptedAgentInvocations } = await import("../server/invocation-health.ts")
  await failInterruptedAgentInvocations(options.store, options.recovery)
  return defineAgentInvocations(options)
}

export { createProcessAgentHost } from './process-host.ts'
export type { ProcessAgentHost, ProcessAgentHostOptions } from './process-host.ts'

/**
 * Starts the process hosts that discovered Agents contribute, for example through the Babysitter
 * preset. The generated Nitro plugin owns one instance per server process.
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
}): {
  start(): void
  close(): Promise<void>
  wake(reason?: string): void
  status(): "starting" | "accepting" | "draining" | "drained" | "failed"
  health(): Promise<{ status: "healthy" | "degraded", agents: Record<string, unknown> }>
} {
  const hosts = new Map<string, import("../agent-process-host.ts").AgentProcessHostInstance>()
  const failures = new Map<string, string>()
  let starting: Promise<void> | undefined
  let closed = false
  // A development server with production credentials must not repair real PRs by accident.
  const enabled = options.enabled ?? (process.env.NODE_ENV === "production" || process.env.VITEHUB_AGENT_PROCESS_HOSTS === "1")
  const retries = new Map<string, ReturnType<typeof setTimeout>>()
  const retryMs = options.retryMs ?? 60_000
  const startHost = async (agentName: string, attempt: number): Promise<void> => {
    retries.delete(agentName)
    if (closed) return
    const { getAgentFromRegistry } = await import("../index.ts")
    const { getAgentProcessHostContribution } = await import("../agent-process-host.ts")
    const { join } = await import("node:path")
    try {
      const agent = await getAgentFromRegistry(agentName, options.registry)
      const contribution = getAgentProcessHostContribution(agent)
      if (!contribution) {
        failures.set(agentName, "The Agent has no process host contribution.")
        return
      }
      const host = await contribution.create({ agentName, agent, state: options.state(), dataDir: join(options.dataDir ?? ".vitehub/agents", agentName) })
      if (closed) {
        await host.close()
        return
      }
      failures.delete(agentName)
      hosts.set(agentName, host)
      host.start()
    }
    catch (error) {
      failures.set(agentName, error instanceof Error ? error.message : String(error))
      console.error(`[vitehub] Agent process host "${agentName}" did not start.`, error)
      // A provider outage at boot, such as an unavailable GitHub API, must not stop the host until the next deploy.
      const delay = Math.min(retryMs * 2 ** attempt, 30 * 60_000)
      const timer = setTimeout(() => { void startHost(agentName, attempt + 1) }, delay)
      timer.unref?.()
      retries.set(agentName, timer)
    }
  }
  return {
    start() {
      if (starting || closed || !enabled) return
      starting = Promise.all(options.names.map(agentName => startHost(agentName, 0))).then(() => undefined)
    },
    async close() {
      closed = true
      for (const timer of retries.values()) clearTimeout(timer)
      retries.clear()
      await starting
      await Promise.all([...hosts.values()].map(host => host.close()))
    },
    wake(reason) {
      for (const host of hosts.values()) host.wake(reason)
    },
    status() {
      if (!enabled) return "drained"
      const statuses = [...hosts.values()].map(host => host.status())
      if (failures.size && !statuses.length) return "failed"
      if (!statuses.length) return closed ? "drained" : "starting"
      for (const status of ["failed", "draining", "starting", "accepting"] as const) if (statuses.includes(status)) return status
      return "drained"
    },
    async health() {
      const agents: Record<string, unknown> = {}
      for (const [name, reason] of failures) agents[name] = { status: "degraded", reason }
      for (const [name, host] of hosts) agents[name] = await host.health()
      if (!enabled) for (const name of options.names) agents[name] = { status: "degraded", reason: "Process hosts start in production or with VITEHUB_AGENT_PROCESS_HOSTS=1." }
      const degraded = Object.values(agents).some(agent => isRuntimeRecord(agent) && agent.status !== "healthy")
      return { status: degraded ? "degraded" : "healthy", agents }
    },
  }
}
