import { afterEach, describe, expect, it, vi } from "vitest"

const { resolveVercelSandbox } = vi.hoisted(() => ({
  resolveVercelSandbox: vi.fn(async () => ({ open: vi.fn(), plan: {} })),
}))

vi.mock("../../src/internal/vercel.ts", () => ({ resolveVercelSandbox }))

import { configureCloudflareSandbox, type CloudflareSandboxEntrypointOptions } from "../../src/task/cloudflare.ts"
import { inspectSandboxTaskResources } from "../../src/task/inspect.ts"
import { resolveVercelTaskSandbox } from "../../src/task/runtime/providers/vercel.ts"
import { resolveCloudflareSandboxTaskInstanceType, resolveVercelSandboxTaskVcpus } from "../../src/task/size.ts"

import type { WranglerContainer } from "../../src/task/internal/shared/cloudflare-target.ts"

afterEach(() => {
  resolveVercelSandbox.mockClear()
})

function configure(options: CloudflareSandboxEntrypointOptions = {}, containers: WranglerContainer[] = []) {
  const target = { cloudflare: { wrangler: { containers } } }
  configureCloudflareSandbox(target, options)
  return target.cloudflare.wrangler.containers[0]!
}

describe("Cloudflare Sandbox Task size", () => {
  it("writes standard-1 and 12 instances by default", () => {
    expect(configure()).toMatchObject({ instance_type: "standard-1", max_instances: 12 })
  })

  it("writes the smallest instance type that fits cpu and memory", () => {
    expect(configure({ memory: 256 }).instance_type).toBe("lite")
    expect(configure({ cpu: 0.25 }).instance_type).toBe("basic")
    expect(configure({ memory: 4096 }).instance_type).toBe("standard-1")
    expect(configure({ cpu: 1 }).instance_type).toBe("standard-2")
    expect(configure({ cpu: 1, memory: 8192 }).instance_type).toBe("standard-3")
    expect(configure({ cpu: 3 }).instance_type).toBe("standard-4")
    expect(configure({ memory: 12288 }).instance_type).toBe("standard-4")
  })

  it("rejects a size above standard-4, the largest Cloudflare Container", () => {
    expect(() => configure({ cpu: 8 })).toThrow(expect.objectContaining({ code: "SANDBOX_TASK_SIZE_TOO_LARGE" }))
    expect(() => configure({ memory: 16384 })).toThrow(expect.objectContaining({ code: "SANDBOX_TASK_SIZE_TOO_LARGE" }))
  })

  it("writes maxInstances", () => {
    expect(configure({ maxInstances: 50 }).max_instances).toBe(50)
  })

  it("keeps the instance type of a containers entry that the app owns", () => {
    expect(configure({}, [{ class_name: "Sandbox", instance_type: "lite" }]).instance_type).toBe("lite")
    expect(configure({ memory: 8192 }, [{ class_name: "Sandbox", instance_type: "standard-4" }]).instance_type).toBe("standard-4")
    const custom = { vcpu: 2, memory_mib: 6144, disk_mb: 8000 }
    expect(configure({ cpu: 1, memory: 6144 }, [{ class_name: "Sandbox", instance_type: custom }]).instance_type).toBe(custom)
  })

  it("rejects cpu or memory that the instance type of an app-owned containers entry cannot give", () => {
    expect(() => configure({ memory: 4096 }, [{ class_name: "Sandbox", instance_type: "lite" }]))
      .toThrow(expect.objectContaining({ code: "SANDBOX_TASK_CLOUDFLARE_INSTANCE_TYPE_TOO_SMALL" }))
    expect(() => configure({ cpu: 2 }, [{ class_name: "Sandbox", instance_type: { vcpu: 1, memory_mib: 4096, disk_mb: 8000 } }]))
      .toThrow(expect.objectContaining({ code: "SANDBOX_TASK_CLOUDFLARE_INSTANCE_TYPE_TOO_SMALL" }))
  })

  it("rejects maxInstances that differs from max_instances of an app-owned containers entry", () => {
    expect(configure({ maxInstances: 2 }, [{ class_name: "Sandbox", max_instances: 2 }]).max_instances).toBe(2)
    expect(() => configure({ maxInstances: 50 }, [{ class_name: "Sandbox", max_instances: 2 }]))
      .toThrow(expect.objectContaining({ code: "SANDBOX_TASK_CLOUDFLARE_MAX_INSTANCES_CONFLICT" }))
  })

  it("reports the instance type and instance limit in the Container resource", () => {
    const [, container] = inspectSandboxTaskResources({ instanceType: "standard-3", maxInstances: 50 })
    expect(container?.note).toContain("standard-3 (2 vCPU, 8192 MiB memory)")
    expect(container?.note).toContain("at most 50 instances")
  })
})

describe("Vercel Sandbox Task size", () => {
  it("maps cpu and memory to 1 or an even vCPU count", () => {
    expect(resolveVercelSandboxTaskVcpus({})).toBeUndefined()
    expect(resolveVercelSandboxTaskVcpus({ cpu: 0.5 })).toBe(1)
    expect(resolveVercelSandboxTaskVcpus({ cpu: 1, memory: 2048 })).toBe(1)
    expect(resolveVercelSandboxTaskVcpus({ memory: 3000 })).toBe(2)
    expect(resolveVercelSandboxTaskVcpus({ cpu: 3 })).toBe(4)
    expect(resolveVercelSandboxTaskVcpus({ memory: 5000 })).toBe(4)
    expect(resolveVercelSandboxTaskVcpus({ cpu: 2, memory: 16384 })).toBe(8)
    expect(resolveVercelSandboxTaskVcpus({ cpu: 31 })).toBe(32)
  })

  it("rejects more than 32 vCPUs", () => {
    expect(() => resolveVercelSandboxTaskVcpus({ cpu: 33 })).toThrow(expect.objectContaining({ code: "SANDBOX_TASK_SIZE_TOO_LARGE" }))
    expect(() => resolveVercelSandboxTaskVcpus({ memory: 65537 })).toThrow(expect.objectContaining({ code: "SANDBOX_TASK_SIZE_TOO_LARGE" }))
  })

  it("creates the Sandbox with the vCPU count that fits memory", async () => {
    const provider = await resolveVercelTaskSandbox({ local: {}, provider: { provider: "vercel", memory: 8192 } })
    await provider.resolveSandbox(["node"])
    expect(resolveVercelSandbox).toHaveBeenLastCalledWith(expect.objectContaining({ cpu: 4 }), ["node"])
  })
})

describe("Sandbox Task size values", () => {
  it.each([
    { cpu: 0 },
    { cpu: -1 },
    { cpu: Number.NaN },
    { memory: 0 },
    { memory: "4 GB" },
    { maxInstances: 0 },
    { maxInstances: 1.5 },
  ])("rejects %o", (options) => {
    expect(() => resolveCloudflareSandboxTaskInstanceType(options as never)).toThrow(expect.objectContaining({ code: "SANDBOX_TASK_SIZE_INVALID" }))
  })
})
