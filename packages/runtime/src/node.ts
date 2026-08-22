import { hasRuntimeType } from "./internal/runtime-type.ts"
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

type TextReadResult = { error?: unknown, value?: string }

async function readResult(readText: ReadText, path: string): Promise<TextReadResult> {
  try {
    return { value: await readText(path) }
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

function cgroupRoot(mountinfo: string, membership: string): string | undefined {
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

async function cgroupObservations(readText: ReadText): Promise<{
  observations: RuntimeResourceObservation[]
  support: RuntimeResourceSupport
}> {
  const membershipRead = await readResult(readText, "/proc/self/cgroup")
  if (membershipRead.value === undefined) {
    return { observations: [], support: { reason: readFailureReason([membershipRead], "unsupported-runtime"), scope: "service", source: "linux-cgroup-v2", supported: false } }
  }
  const relative = membershipRead.value.split("\n").find(line => line.startsWith("0::"))?.slice(3)
  if (relative === undefined) {
    return { observations: [], support: { reason: "unsupported-runtime", scope: "service", source: "linux-cgroup-v2", supported: false } }
  }
  const mountinfoRead = await readResult(readText, "/proc/self/mountinfo")
  if (mountinfoRead.value === undefined) {
    return { observations: [], support: { reason: readFailureReason([mountinfoRead], "mount-unavailable"), scope: "service", source: "linux-cgroup-v2", supported: false } }
  }
  const root = cgroupRoot(mountinfoRead.value, relative)
  if (!root) {
    return { observations: [], support: { reason: "mount-unavailable", scope: "service", source: "linux-cgroup-v2", supported: false } }
  }
  const reads = await Promise.all([
    readResult(readText, join(root, "memory.current")),
    readResult(readText, join(root, "memory.peak")),
    readResult(readText, join(root, "memory.high")),
    readResult(readText, join(root, "memory.max")),
    readResult(readText, join(root, "memory.swap.current")),
    readResult(readText, join(root, "memory.swap.peak")),
    readResult(readText, join(root, "memory.events")),
    readResult(readText, join(root, "cpu.stat")),
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
  const readText = options.readText || (async path => await readFile(path, "utf8"))
  return {
    async inspect(): Promise<RuntimeResourceSnapshot> {
      const memory = memoryUsage()
      const usage = resourceUsage()
      const linux = process.platform === "linux"
      const [cgroup, linuxMeminfo] = linux
        ? await Promise.all([cgroupObservations(readText), readResult(readText, "/proc/meminfo")])
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
