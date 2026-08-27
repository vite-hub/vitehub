import { readFile } from "node:fs/promises"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createProcessAgentCapacity } from "../src/runtime/process.ts"

const GiB = 1024 ** 3

const resources = vi.hoisted(() => ({
  availableMemory: 8 * 1024 ** 3,
  cgroupAvailable: true,
  cpuPressure: 0,
  memoryCurrent: 2 * 1024 ** 3,
  memoryHigh: 8 * 1024 ** 3,
  memoryHighEvents: 0,
  memoryMax: 10 * 1024 ** 3,
  memoryPressure: 0,
  parallelism: 8,
  pressureAvailable: true,
}))

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (path: string | URL, _options: { encoding: "utf8", signal: AbortSignal }) => {
    const value = String(path)
    if (value === "/proc/self/cgroup") {
      if (!resources.cgroupAvailable) throw new Error("cgroup v2 unavailable")
      return "0::/vitehub-test\n"
    }
    if (value === "/proc/self/mountinfo") {
      return "29 23 0:26 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n"
    }
    if (value.endsWith("/memory.current")) return String(resources.memoryCurrent)
    if (value.endsWith("/memory.high")) return String(resources.memoryHigh)
    if (value.endsWith("/memory.max")) return String(resources.memoryMax)
    if (value.endsWith("/memory.events")) return `low 0\nhigh ${resources.memoryHighEvents}\nmax 0\n`
    if (value.endsWith(".pressure") && !resources.pressureAvailable) throw new Error("PSI unavailable")
    if (value.endsWith("/cpu.pressure")) return pressure(resources.cpuPressure)
    if (value.endsWith("/memory.pressure")) return pressure(resources.memoryPressure)
    throw new Error(`Unexpected resource path: ${value}`)
  }),
}))

vi.mock("node:os", () => ({
  availableParallelism: () => resources.parallelism,
  freemem: () => resources.availableMemory,
}))

function pressure(value: number): string {
  return `some avg10=${value * 100} avg60=0.00 avg300=0.00 total=0\n`
}

function createBuiltInSample(options: Parameters<typeof createProcessAgentCapacity>[0] = { concurrency: 6 }) {
  const sample = createProcessAgentCapacity(options).adaptive?.sample
  if (!sample) throw new Error("Expected process capacity to configure an adaptive sample")
  return sample
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(resources, {
    availableMemory: 8 * GiB,
    cgroupAvailable: true,
    cpuPressure: 0,
    memoryCurrent: 2 * GiB,
    memoryHigh: 8 * GiB,
    memoryHighEvents: 0,
    memoryMax: 10 * GiB,
    memoryPressure: 0,
    parallelism: 8,
    pressureAvailable: true,
  })
  vi.spyOn(process, "availableMemory").mockImplementation(() => resources.availableMemory)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("process Agent capacity", () => {
  it("stays paused while memory.high events keep increasing", async () => {
    const sample = createBuiltInSample()
    const controller = new AbortController()
    const context = { active: 0, concurrency: 6, pending: 1, signal: controller.signal }

    await expect(sample(context)).resolves.toMatchObject({ concurrency: 5 })
    expect(vi.mocked(readFile)).toHaveBeenCalledWith("/proc/self/cgroup", {
      encoding: "utf8",
      signal: controller.signal,
    })
    expect(vi.mocked(readFile)).toHaveBeenCalledWith("/sys/fs/cgroup/vitehub-test/memory.events", {
      encoding: "utf8",
      signal: controller.signal,
    })
    expect(vi.mocked(readFile).mock.calls.map(([, readOptions]) => readOptions)).toEqual(
      Array.from({ length: 8 }, () => ({ encoding: "utf8", signal: controller.signal })),
    )

    resources.memoryHighEvents = 1
    await expect(sample(context)).resolves.toEqual({ concurrency: 0, reason: "memory.high event" })

    resources.memoryHighEvents = 2
    await expect(sample(context)).resolves.toEqual({ concurrency: 0, reason: "memory.high event" })

    await expect(sample(context)).resolves.toMatchObject({ concurrency: 5 })
  })

  it("resolves cgroup files through a namespaced cgroup v2 mount", async () => {
    vi.mocked(readFile).mockImplementation(async (path) => {
      const value = String(path)
      if (value === "/proc/self/cgroup") return "0::/tenant.slice/service\n"
      if (value === "/proc/self/mountinfo") {
        return "29 23 0:26 /tenant.slice/service /run/cgroup\\040view rw - cgroup2 cgroup rw\n"
      }
      if (value.endsWith("/memory.current")) return String(resources.memoryCurrent)
      if (value.endsWith("/memory.high")) return String(resources.memoryHigh)
      if (value.endsWith("/memory.max")) return String(resources.memoryMax)
      if (value.endsWith("/memory.events")) return `low 0\nhigh ${resources.memoryHighEvents}\nmax 0\n`
      if (value.endsWith("/cpu.pressure")) return pressure(resources.cpuPressure)
      if (value.endsWith("/memory.pressure")) return pressure(resources.memoryPressure)
      throw new Error(`Unexpected resource path: ${value}`)
    })

    const sample = createBuiltInSample()
    await sample({ active: 0, concurrency: 6, pending: 1, signal: new AbortController().signal })

    expect(vi.mocked(readFile)).toHaveBeenCalledWith("/run/cgroup view/memory.current", expect.any(Object))
  })

  it("uses Node memory when cgroup v2 data is unavailable", async () => {
    resources.cgroupAvailable = false
    resources.availableMemory = 5 * GiB
    const sample = createBuiltInSample({
      concurrency: 6,
      memory: { perInvocationBytes: 2 * GiB, reserveBytes: GiB },
    })

    await expect(sample({ active: 1, concurrency: 6, pending: 0, signal: new AbortController().signal })).resolves.toEqual({
      concurrency: 3,
      reason: "capacity available (5.0 GiB memory headroom)",
    })
  })

  it("bounds cgroup headroom by Node available memory", async () => {
    resources.availableMemory = 3 * GiB
    const sample = createBuiltInSample({
      concurrency: 6,
      memory: { perInvocationBytes: GiB, reserveBytes: GiB },
    })

    await expect(sample({ active: 1, concurrency: 6, pending: 1, signal: new AbortController().signal })).resolves.toEqual({
      concurrency: 3,
      reason: "capacity available (3.0 GiB memory headroom)",
    })
  })

  it("keeps cgroup memory limits when PSI files are unavailable", async () => {
    resources.pressureAvailable = false
    resources.memoryHigh = 4 * GiB
    const sample = createBuiltInSample({
      concurrency: 6,
      memory: { perInvocationBytes: GiB, reserveBytes: GiB },
    })

    await expect(sample({ active: 1, concurrency: 6, pending: 1, signal: new AbortController().signal })).resolves.toEqual({
      concurrency: 2,
      reason: "capacity available (2.0 GiB memory headroom)",
    })
  })

  it("uses separate pause and resume thresholds for CPU pressure", async () => {
    const sample = createBuiltInSample()
    const context = { active: 0, concurrency: 6, pending: 1, signal: new AbortController().signal }

    resources.cpuPressure = 0.26
    await expect(sample(context)).resolves.toMatchObject({ concurrency: 0 })

    resources.cpuPressure = 0.15
    await expect(sample(context)).resolves.toMatchObject({ concurrency: 0 })

    resources.cpuPressure = 0.09
    await expect(sample(context)).resolves.toMatchObject({ concurrency: 5 })
  })

  it("uses separate pause and resume thresholds for memory pressure", async () => {
    const sample = createBuiltInSample()
    const context = { active: 0, concurrency: 6, pending: 1, signal: new AbortController().signal }

    resources.memoryPressure = 0.06
    await expect(sample(context)).resolves.toMatchObject({ concurrency: 0 })

    resources.memoryPressure = 0.02
    await expect(sample(context)).resolves.toMatchObject({ concurrency: 0 })

    resources.memoryPressure = 0.009
    await expect(sample(context)).resolves.toMatchObject({ concurrency: 5 })
  })

  it("resumes at zero pressure when the resume thresholds are zero", async () => {
    const sample = createBuiltInSample({
      concurrency: 6,
      cpu: { resumePressure: 0 },
      memory: { resumePressure: 0 },
    })
    const context = { active: 0, concurrency: 6, pending: 1, signal: new AbortController().signal }

    resources.cpuPressure = 0.26
    resources.memoryPressure = 0.06
    await expect(sample(context)).resolves.toMatchObject({ concurrency: 0 })

    resources.cpuPressure = 0
    resources.memoryPressure = 0
    await expect(sample(context)).resolves.toMatchObject({ concurrency: 5 })
  })

  it("validates and forwards the adaptive sample timeout", () => {
    expect(() => createProcessAgentCapacity({ concurrency: 1, sampleTimeoutMs: 0 })).toThrow(
      "sampleTimeoutMs }) must be a positive finite number no greater than 2147483647",
    )

    expect(createProcessAgentCapacity({ concurrency: 1 }).adaptive).toMatchObject({ sampleTimeoutMs: 1_000 })
    expect(createProcessAgentCapacity({ concurrency: 1, sampleTimeoutMs: 0.5 }).adaptive).toMatchObject({
      sampleTimeoutMs: 0.5,
    })
  })
})
