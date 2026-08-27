import { readFile } from "node:fs/promises"
import { availableParallelism, freemem } from "node:os"

import { resolveLinuxCgroupV2Path } from "@vite-hub/runtime/node"

import { shareAgentCapacityOptions } from "../internal/agent-capacity.ts"

import type { AgentDriverCapacityOptions, AgentDriverCapacityQueueOptions, AgentDriverCapacitySample, AgentDriverCapacitySampleContext } from "../types.ts"

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
  parallelism: number
}

export function createProcessAgentCapacity(options: ProcessAgentCapacityOptions): AgentDriverCapacityOptions {
  if (!options || !Number.isInteger(options.concurrency) || options.concurrency <= 0) {
    throw new TypeError("[vitehub] createProcessAgentCapacity({ concurrency }) must be a positive integer.")
  }
  const fallbackConcurrency = options.fallbackConcurrency ?? 1
  const intervalMs = options.intervalMs ?? 5_000
  const rampUp = options.rampUp ?? 1
  const sampleTimeoutMs = options.sampleTimeoutMs ?? 1_000
  if (!Number.isInteger(fallbackConcurrency) || fallbackConcurrency < 0 || fallbackConcurrency > options.concurrency) {
    throw new TypeError("[vitehub] createProcessAgentCapacity({ fallbackConcurrency }) must be an integer between zero and concurrency.")
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 100 || intervalMs > 2_147_483_647) {
    throw new TypeError("[vitehub] createProcessAgentCapacity({ intervalMs }) must be a finite number between 100 and 2147483647.")
  }
  if (!Number.isInteger(rampUp) || rampUp <= 0) {
    throw new TypeError("[vitehub] createProcessAgentCapacity({ rampUp }) must be a positive integer.")
  }
  if (!Number.isFinite(sampleTimeoutMs) || sampleTimeoutMs <= 0 || sampleTimeoutMs > 2_147_483_647) {
    throw new TypeError("[vitehub] createProcessAgentCapacity({ sampleTimeoutMs }) must be a positive finite number no greater than 2147483647.")
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
    throw new TypeError("[vitehub] createProcessAgentCapacity({ memory.perInvocationBytes }) must be a positive finite number.")
  }
  if (!Number.isFinite(memory.reserveBytes) || memory.reserveBytes < 0) {
    throw new TypeError("[vitehub] createProcessAgentCapacity({ memory.reserveBytes }) must be a non-negative finite number.")
  }
  if (options.sample !== undefined && typeof options.sample !== "function") {
    throw new TypeError("[vitehub] createProcessAgentCapacity({ sample }) must be a function.")
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
          resources.cpuPressure >= cpu.pausePressure || resources.memoryPressure >= memory.pausePressure || memoryHighIncreased
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
      const cpuConcurrency = Math.max(1, resources.parallelism)
      const concurrency = Math.max(0, Math.min(context.concurrency, memoryConcurrency, cpuConcurrency))
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
    throw new TypeError(`[vitehub] createProcessAgentCapacity({ ${name}.pausePressure }) must be between zero and one.`)
  }
  if (!Number.isFinite(value.resumePressure) || value.resumePressure < 0 || value.resumePressure > value.pausePressure) {
    throw new TypeError(
      `[vitehub] createProcessAgentCapacity({ ${name}.resumePressure }) must be between zero and pausePressure.`,
    )
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
    parallelism: availableParallelism(),
  }
}

async function readCgroupResources(signal: AbortSignal): Promise<Omit<ProcessResourceSample, "availableMemory" | "parallelism">> {
  const membership = await readFile("/proc/self/cgroup", { encoding: "utf8", signal })
  const relative = membership
    .split(/\r?\n/)
    .map((line) => line.split(":"))
    .find((parts) => parts[0] === "0")?.[2]
  if (relative === undefined) throw new Error("cgroup v2 membership is unavailable")
  const mountinfo = await readFile("/proc/self/mountinfo", { encoding: "utf8", signal })
  const root = resolveLinuxCgroupV2Path(mountinfo, relative)
  if (root === undefined) throw new Error("cgroup v2 mount is unavailable")
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
    memoryCurrent: Number(current.trim()),
    memoryHigh: parseLimit(high),
    memoryHighEvents: parseEvent(events, "high"),
    memoryMax: parseLimit(max),
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
  return line ? Number(line.slice(name.length + 1)) : 0
}

function parseLimit(value: string): number {
  const parsed = value.trim()
  return parsed === "max" ? Number.POSITIVE_INFINITY : Number(parsed)
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
