import { readFile, stat } from "node:fs/promises"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createProcessAgentCapacity } from "../src/runtime/process.ts"

const GiB = 1024 ** 3

const resources = vi.hoisted(() => ({
  hostAvailableMemory: 16 * 1024 ** 3,
  hostCpuPressure: 0,
  hostMemoryPressure: 0,
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
  stat: vi.fn(async () => ({ ino: 1 })),
  readFile: vi.fn(async (path: string | URL, _options: { encoding: "utf8", signal: AbortSignal }) => {
    const value = String(path)
    if (value === "/proc/meminfo") return `MemAvailable: ${resources.hostAvailableMemory / 1024} kB\n`;
    if (value === "/proc/pressure/cpu") return pressure(resources.hostCpuPressure);
    if (value === "/proc/pressure/memory") return pressure(resources.hostMemoryPressure);
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

const defaultReadFile = vi.mocked(readFile).getMockImplementation();

beforeEach(() => {
  if (!defaultReadFile) throw new Error("Expected default resource reader");
  vi.mocked(readFile).mockImplementation(defaultReadFile);
  vi.mocked(stat).mockResolvedValue({ ino: 1 } as Awaited<ReturnType<typeof stat>>);
  vi.clearAllMocks()
  Object.assign(resources, {
    hostAvailableMemory: 16 * GiB,
    hostCpuPressure: 0,
    hostMemoryPressure: 0,
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
  function delegatedHierarchy() {
    const original = vi.mocked(readFile).getMockImplementation();
    if (!original) throw new Error("Expected resource reader");
    const groups = new Map([
      ["/sys/fs/cgroup/service/controller", { ...resources, memoryCurrent: GiB, memoryHigh: Infinity, memoryMax: Infinity }],
      ["/sys/fs/cgroup/service", { ...resources, memoryCurrent: 6 * GiB, memoryHigh: 8 * GiB, memoryMax: 10 * GiB }],
      ["/sys/fs/cgroup", { ...resources, memoryCurrent: 16 * GiB, memoryHigh: Infinity, memoryMax: Infinity }],
    ]);
    vi.mocked(readFile).mockImplementation(async (path, options) => {
      const value = String(path);
      if (value === "/proc/self/cgroup") return "0::/service/controller\n";
      const group = groups.get(value.slice(0, value.lastIndexOf("/")));
      if (group) {
        if (value.endsWith("/memory.current")) return String(group.memoryCurrent);
        if (value.endsWith("/memory.high")) return Number.isFinite(group.memoryHigh) ? String(group.memoryHigh) : "max";
        if (value.endsWith("/memory.max")) return Number.isFinite(group.memoryMax) ? String(group.memoryMax) : "max";
        if (value.endsWith("/memory.events")) return `high ${group.memoryHighEvents}\n`;
        if (value.endsWith("/cpu.pressure")) return pressure(group.cpuPressure);
        if (value.endsWith("/memory.pressure")) return pressure(group.memoryPressure);
      }
      return original(path, options);
    });
    return groups;
  }

  it("bounds a delegated controller by aggregate service headroom", async () => {
    delegatedHierarchy();
    const sample = createBuiltInSample();
    await expect(sample({ active: 0, concurrency: 6, pending: 1, signal: new AbortController().signal })).resolves.toMatchObject({ concurrency: 1 });
    expect(vi.mocked(readFile)).toHaveBeenCalledWith("/sys/fs/cgroup/service/memory.current", expect.any(Object));
    expect(vi.mocked(readFile)).not.toHaveBeenCalledWith("/sys/fs/memory.current", expect.any(Object));
  });

  it("pauses for service-parent high events and pressure with a healthy controller", async () => {
    const groups = delegatedHierarchy();
    const parent = groups.get("/sys/fs/cgroup/service");
    if (!parent) throw new Error("Expected service parent");
    const sample = createBuiltInSample();
    const context = { active: 0, concurrency: 6, pending: 1, signal: new AbortController().signal };
    await sample(context);
    parent.memoryHighEvents++;
    await expect(sample(context)).resolves.toMatchObject({ concurrency: 0, reason: "memory.high event" });
    parent.memoryPressure = 0.06;
    await expect(sample(context)).resolves.toMatchObject({ concurrency: 0 });
    parent.memoryPressure = 0;
    await expect(sample(context)).resolves.toMatchObject({ concurrency: 1 });
  });

  it("keeps service bounds when the real hierarchy root has no memory controller files", async () => {
    delegatedHierarchy();
    const original = vi.mocked(readFile).getMockImplementation();
    if (!original) throw new Error("Expected resource reader");
    vi.mocked(readFile).mockImplementation(async (path, options) => {
      if (["memory.current", "memory.events", "memory.high", "memory.max"].some(file => String(path) === `/sys/fs/cgroup/${file}`)) throw Object.assign(new Error("absent root metric"), { code: "ENOENT" });
      return original(path, options);
    });
    await expect(createBuiltInSample()({ active: 0, concurrency: 6, pending: 1, signal: new AbortController().signal })).resolves.toMatchObject({ concurrency: 1 });
  });

  it.each([
    "service/controller/memory.current",
    "service/controller/memory.events",
    "service/controller/memory.high",
    "service/controller/memory.max",
    "service/memory.current",
    "service/memory.events",
    "service/memory.high",
    "service/memory.max",
  ])("reports missing required cgroup file %s instead of admitting workers", async file => {
    delegatedHierarchy();
    const original = vi.mocked(readFile).getMockImplementation();
    if (!original) throw new Error("Expected resource reader");
    vi.mocked(readFile).mockImplementation(async (path, options) => {
      if (String(path) === `/sys/fs/cgroup/${file}`) throw Object.assign(new Error("missing required file"), { code: "ENOENT" });
      return original(path, options);
    });
    await expect(createBuiltInSample()({ active: 0, concurrency: 6, pending: 1, signal: new AbortController().signal })).rejects.toThrow("missing required file");
  });

  it("requires limits at a namespaced mount of a non-root cgroup", async () => {
    delegatedHierarchy();
    const original = vi.mocked(readFile).getMockImplementation();
    if (!original) throw new Error("Expected resource reader");
    vi.mocked(readFile).mockImplementation(async (path, options) => {
      if (String(path) === "/proc/self/mountinfo") return "29 23 0:26 /service/controller /sys/fs/cgroup rw - cgroup2 cgroup rw\n";
      if (String(path) === "/sys/fs/cgroup/memory.high") throw Object.assign(new Error("missing namespaced limit"), { code: "ENOENT" });
      return original(path, options);
    });
    await expect(createBuiltInSample()({ active: 0, concurrency: 6, pending: 1, signal: new AbortController().signal })).rejects.toThrow("missing namespaced limit");
  });

  it.each(["memory.current", "memory.events", "memory.high", "memory.max"])("requires %s at a remounted cgroup namespace root", async file => {
    vi.mocked(stat).mockResolvedValue({ ino: 1234 } as Awaited<ReturnType<typeof stat>>);
    const original = vi.mocked(readFile).getMockImplementation();
    if (!original) throw new Error("Expected resource reader");
    vi.mocked(readFile).mockImplementation(async (path, options) => {
      if (String(path) === "/proc/self/cgroup") return "0::/\n";
      if (String(path) === `/sys/fs/cgroup/${file}`) throw Object.assign(new Error("missing namespace root limit"), { code: "ENOENT" });
      return original(path, options);
    });
    await expect(createBuiltInSample()({ active: 0, concurrency: 6, pending: 1, signal: new AbortController().signal })).rejects.toThrow("missing namespace root limit");
  });

  it("fails sampling when the hierarchy root cannot be verified", async () => {
    vi.mocked(stat).mockRejectedValue(Object.assign(new Error("stat denied"), { code: "EACCES" }));
    const original = vi.mocked(readFile).getMockImplementation();
    if (!original) throw new Error("Expected resource reader");
    vi.mocked(readFile).mockImplementation(async (path, options) => {
      if (String(path) === "/sys/fs/cgroup/memory.high") throw Object.assign(new Error("absent root limit"), { code: "ENOENT" });
      return original(path, options);
    });
    await expect(createBuiltInSample()({ active: 0, concurrency: 6, pending: 1, signal: new AbortController().signal })).rejects.toThrow("stat denied");
  });

  it("reports an unreadable known ancestor instead of discarding cgroup limits", async () => {
    delegatedHierarchy();
    const original = vi.mocked(readFile).getMockImplementation();
    if (!original) throw new Error("Expected resource reader");
    vi.mocked(readFile).mockImplementation(async (path, options) => {
      if (String(path) === "/sys/fs/cgroup/service/memory.current") throw Object.assign(new Error("denied"), { code: "EACCES" });
      return original(path, options);
    });
    await expect(createBuiltInSample()({ active: 0, concurrency: 6, pending: 1, signal: new AbortController().signal })).rejects.toThrow("denied");
  });

  it.each([true, false])("pauses for host memory pressure with cgroup available=%s", async cgroupAvailable => {
    resources.cgroupAvailable = cgroupAvailable;
    resources.availableMemory = 5 * GiB;
    resources.hostMemoryPressure = 0.06;
    const sample = createBuiltInSample();
    await expect(sample({ active: 1, concurrency: 6, pending: 1, signal: new AbortController().signal })).resolves.toMatchObject({ concurrency: 0 });
    resources.hostMemoryPressure = 0.02;
    await expect(sample({ active: 1, concurrency: 6, pending: 1, signal: new AbortController().signal })).resolves.toMatchObject({ concurrency: 0 });
    resources.hostMemoryPressure = 0;
    await expect(sample({ active: 1, concurrency: 6, pending: 1, signal: new AbortController().signal })).resolves.toMatchObject({ concurrency: 4 });
  });

  it("pauses for host CPU pressure with a healthy worker cgroup", async () => {
    resources.hostCpuPressure = 0.26;
    await expect(createBuiltInSample()({ active: 0, concurrency: 6, pending: 1, signal: new AbortController().signal })).resolves.toMatchObject({ concurrency: 0 });
  });

  it("reserves growth headroom for already active workers", async () => {
    resources.cgroupAvailable = false;
    resources.availableMemory = 5 * GiB;
    const sample = createBuiltInSample({ concurrency: 6, memory: { perInvocationBytes: 2 * GiB, reserveBytes: GiB } });
    await expect(sample({ active: 2, concurrency: 6, pending: 1, signal: new AbortController().signal })).resolves.toMatchObject({ concurrency: 2 });
  });

  it("keeps a large host reserve separate from a smaller service budget", async () => {
    resources.hostAvailableMemory = 32 * GiB;
    resources.availableMemory = 6 * GiB;
    resources.memoryHigh = 8 * GiB;
    const sample = createBuiltInSample({ concurrency: 6, memory: { reserveBytes: 8 * GiB, serviceReserveBytes: GiB, perInvocationBytes: 2 * GiB } });
    await expect(sample({ active: 0, concurrency: 6, pending: 1, signal: new AbortController().signal })).resolves.toMatchObject({ concurrency: 2 });
  });

  it("bounds admission by host MemAvailable even when Node reports more", async () => {
    resources.hostAvailableMemory = 2 * GiB;
    const sample = createBuiltInSample();
    await expect(sample({ active: 0, concurrency: 6, pending: 1, signal: new AbortController().signal })).resolves.toMatchObject({ concurrency: 1 });
  });

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
    for (const [, readOptions] of vi.mocked(readFile).mock.calls) expect(readOptions).toEqual({ encoding: "utf8", signal: controller.signal })

    resources.memoryHighEvents = 1
    await expect(sample(context)).resolves.toEqual({ concurrency: 0, reason: "memory.high event" })

    resources.memoryHighEvents = 2
    await expect(sample(context)).resolves.toEqual({ concurrency: 0, reason: "memory.high event" })

    await expect(sample(context)).resolves.toMatchObject({ concurrency: 5 })
  })

  it("resolves colon-containing membership paths through a namespaced cgroup v2 mount", async () => {
    vi.mocked(readFile).mockImplementation(async (path) => {
      const value = String(path)
      if (value === "/proc/self/cgroup") return "0::/tenant.slice/foo:bar/service\n"
      if (value === "/proc/self/mountinfo") {
        return "29 23 0:26 /tenant.slice/foo:bar/service /run/cgroup\\040view rw - cgroup2 cgroup rw\n"
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
      concurrency: 2,
      reason: "capacity available (5.0 GiB memory headroom)",
    })
  })

  it("honors configured concurrency above host CPU count", async () => {
    resources.availableMemory = 16 * GiB
    resources.memoryHigh = 20 * GiB
    resources.memoryMax = 20 * GiB
    resources.parallelism = 2
    const sample = createBuiltInSample({ concurrency: 10 })

    await expect(sample({ active: 0, concurrency: 10, pending: 1, signal: new AbortController().signal })).resolves.toEqual({
      concurrency: 10,
      reason: "capacity available (16.0 GiB memory headroom)",
    })
  })

  it("bounds cgroup headroom by Node available memory", async () => {
    resources.availableMemory = 3 * GiB
    const sample = createBuiltInSample({
      concurrency: 6,
      memory: { perInvocationBytes: GiB, reserveBytes: GiB },
    })

    await expect(sample({ active: 1, concurrency: 6, pending: 1, signal: new AbortController().signal })).resolves.toEqual({
      concurrency: 2,
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
      concurrency: 1,
      reason: "waiting for capacity (2.0 GiB memory headroom)",
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

  it("remains available at zero pressure when the pause thresholds are zero", async () => {
    const sample = createBuiltInSample({
      concurrency: 6,
      cpu: { pausePressure: 0, resumePressure: 0 },
      memory: { pausePressure: 0, resumePressure: 0 },
    })
    const context = { active: 0, concurrency: 6, pending: 1, signal: new AbortController().signal }

    resources.cpuPressure = 0
    resources.memoryPressure = 0
    await expect(sample(context)).resolves.toMatchObject({ concurrency: 5 })
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
