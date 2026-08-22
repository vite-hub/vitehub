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

type ReadText = (path: string) => Promise<string>

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

async function optionalRead(readText: ReadText, path: string): Promise<string | undefined> {
  try {
    return await readText(path)
  }
  catch {
    return undefined
  }
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

async function cgroupObservations(readText: ReadText): Promise<{
  observations: RuntimeResourceObservation[]
  support: RuntimeResourceSupport
}> {
  const membership = await optionalRead(readText, "/proc/self/cgroup")
  const relative = membership?.split("\n").find(line => line.startsWith("0::"))?.slice(3)
  if (relative === undefined) {
    return { observations: [], support: { reason: "unsupported-runtime", scope: "service", source: "linux-cgroup-v2", supported: false } }
  }
  const root = join("/sys/fs/cgroup", relative)
  const [current, peak, high, max, swapCurrent, swapPeak, events, cpu] = await Promise.all([
    optionalRead(readText, join(root, "memory.current")),
    optionalRead(readText, join(root, "memory.peak")),
    optionalRead(readText, join(root, "memory.high")),
    optionalRead(readText, join(root, "memory.max")),
    optionalRead(readText, join(root, "memory.swap.current")),
    optionalRead(readText, join(root, "memory.swap.peak")),
    optionalRead(readText, join(root, "memory.events")),
    optionalRead(readText, join(root, "cpu.stat")),
  ])
  if (current === undefined && events === undefined && cpu === undefined) {
    return { observations: [], support: { reason: "permission-denied", scope: "service", source: "linux-cgroup-v2", supported: false } }
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
  const readText = options.readText || (async path => await readFile(path, "utf8"))
  return {
    async inspect(): Promise<RuntimeResourceSnapshot> {
      const memory = memoryUsage()
      const usage = resourceUsage()
      const linux = process.platform === "linux"
      const [cgroup, linuxMeminfo] = linux
        ? await Promise.all([cgroupObservations(readText), optionalRead(readText, "/proc/meminfo")])
        : [{ observations: [], support: { reason: "unsupported-runtime", scope: "service", source: "linux-cgroup-v2", supported: false } as const }, undefined] as const
      const host = meminfo(linuxMeminfo)
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
            ...(linuxMeminfo === undefined ? { reason: linux ? "collection-failed" as const : "unsupported-runtime" as const } : {}),
            scope: "host",
            source: "linux-proc",
            supported: linuxMeminfo !== undefined,
          },
          cgroup.support,
        ],
      }
    },
  }
}
