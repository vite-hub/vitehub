import { describe, expect, it, vi } from "vitest"

import { nodeRuntimeResources } from "../src/node.ts"

describe("Node Runtime diagnostics", () => {
  it("reports process, host, and cgroup observations with honest scopes", async () => {
    const files: Record<string, string> = {
      "/proc/self/cgroup": "0::/user.slice/babysitter.service\n",
      "/proc/meminfo": "MemAvailable:       4194304 kB\nSwapFree:            2097152 kB\n",
      "/sys/fs/cgroup/user.slice/babysitter.service/memory.current": "1048576\n",
      "/sys/fs/cgroup/user.slice/babysitter.service/memory.peak": "2097152\n",
      "/sys/fs/cgroup/user.slice/babysitter.service/memory.high": "max\n",
      "/sys/fs/cgroup/user.slice/babysitter.service/memory.max": "6291456\n",
      "/sys/fs/cgroup/user.slice/babysitter.service/memory.swap.current": "524288\n",
      "/sys/fs/cgroup/user.slice/babysitter.service/memory.swap.peak": "1048576\n",
      "/sys/fs/cgroup/user.slice/babysitter.service/memory.events": "high 2\nmax 1\noom 0\noom_kill 0\n",
      "/sys/fs/cgroup/user.slice/babysitter.service/cpu.stat": "usage_usec 123\n",
    }
    const inspector = nodeRuntimeResources({
      now: () => new Date("2026-08-22T10:00:00.000Z"),
      readText: async path => files[path] ?? Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })),
    })

    const snapshot = await inspector.inspect()

    expect(snapshot.observedAt).toBe("2026-08-22T10:00:00.000Z")
    expect(snapshot.support).toContainEqual({ scope: "service", source: "linux-cgroup-v2", supported: true })
    expect(snapshot.observations).toEqual(expect.arrayContaining([
      { name: "memory.current", scope: "service", source: "linux-cgroup-v2", unit: "bytes", value: 1_048_576 },
      { name: "memory.peak", scope: "service", source: "linux-cgroup-v2", unit: "bytes", value: 2_097_152 },
      { name: "memory.rss", scope: "process", source: "node", unit: "bytes", value: expect.any(Number) },
      { name: "memory.available", scope: "host", source: "linux-proc", unit: "bytes", value: 4_294_967_296 },
    ]))
    expect(snapshot.observations.some(item => item.name === "memory.high")).toBe(false)
  })

  it("reports Linux-only sources as unsupported on other platforms", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin")
    const inspector = nodeRuntimeResources()

    const snapshot = await inspector.inspect()

    expect(snapshot.support).toEqual(expect.arrayContaining([
      { reason: "unsupported-runtime", scope: "host", source: "linux-proc", supported: false },
      { reason: "unsupported-runtime", scope: "service", source: "linux-cgroup-v2", supported: false },
    ]))
    platform.mockRestore()
  })
})
