import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtimeMocks = vi.hoisted(() => ({
  createSandboxClient: vi.fn(),
  executeSandboxDefinition: vi.fn(),
  resolveSandboxProvider: vi.fn(async ({ provider }: { provider: Record<string, unknown> }) => provider),
}))

vi.mock("../src/runtime/execute.ts", () => ({
  executeSandboxDefinition: runtimeMocks.executeSandboxDefinition,
}))

vi.mock("vitehub-sandbox-provider-loader", () => ({
  loadSandboxRuntimeProvider: async () => ({
    createSandboxClient: runtimeMocks.createSandboxClient,
    resolveSandboxProvider: runtimeMocks.resolveSandboxProvider,
  }),
}))

import { runSandboxRuntime } from "../src/runtime/runtime.ts"
import { createCloudflareExecutionSandboxId } from "../src/runtime/provider-resolution.ts"
import { resetSandboxRuntimeState, setSandboxRuntimeConfig, setSandboxRuntimeRegistry } from "../src/runtime/state.ts"

const definition = {
  bundle: {
    entry: "index.mjs",
    modules: { "index.mjs": "export default async () => ({ ok: true })" },
  },
}

function createSandbox(provider: "cloudflare" | "vercel") {
  return {
    provider,
    stop: vi.fn(async () => {}),
  }
}

afterEach(() => {
  resetSandboxRuntimeState()
})

beforeEach(() => {
  runtimeMocks.createSandboxClient.mockReset()
  runtimeMocks.executeSandboxDefinition.mockReset()
  runtimeMocks.resolveSandboxProvider.mockReset()
  runtimeMocks.resolveSandboxProvider.mockImplementation(async ({ provider }) => provider)
})

describe("Sandbox runtime lifecycle", () => {
  it("keeps distinct Definition names distinct in default Cloudflare identities", () => {
    expect(createCloudflareExecutionSandboxId("tools/release-notes")).toBe("tools%2Frelease-notes")
    expect(createCloudflareExecutionSandboxId("tools/release-notes"))
      .not.toBe(createCloudflareExecutionSandboxId("tools_release-notes"))
    expect(createCloudflareExecutionSandboxId("Example"))
      .not.toBe(createCloudflareExecutionSandboxId("example"))
  })

  it("uses the Definition name as the default Cloudflare identity and keeps successful runs idle", async () => {
    const sandbox = createSandbox("cloudflare")
    setSandboxRuntimeConfig({ provider: "cloudflare" })
    setSandboxRuntimeRegistry({ example: definition })
    runtimeMocks.createSandboxClient.mockResolvedValue(sandbox)
    runtimeMocks.executeSandboxDefinition.mockResolvedValue({ ok: true })

    const result = await runSandboxRuntime("example")

    expect(result.isOk()).toBe(true)
    expect(runtimeMocks.createSandboxClient).toHaveBeenCalledWith(expect.objectContaining({
      provider: "cloudflare",
      sandboxId: "example",
    }))
    expect(sandbox.stop).not.toHaveBeenCalled()
  })

  it("keeps configured and per-run Cloudflare identity overrides", async () => {
    const sandbox = createSandbox("cloudflare")
    setSandboxRuntimeConfig({ provider: "cloudflare", sandboxId: "configured" })
    setSandboxRuntimeRegistry({ example: definition })
    runtimeMocks.createSandboxClient.mockResolvedValue(sandbox)
    runtimeMocks.executeSandboxDefinition.mockResolvedValue({ ok: true })

    await runSandboxRuntime("example")
    await runSandboxRuntime("example", undefined, { sandboxId: "per-run" })

    expect(runtimeMocks.createSandboxClient).toHaveBeenNthCalledWith(1, expect.objectContaining({ sandboxId: "configured" }))
    expect(runtimeMocks.createSandboxClient).toHaveBeenNthCalledWith(2, expect.objectContaining({ sandboxId: "per-run" }))
  })

  it("leaves failed shared Cloudflare sandboxes to the idle timeout", async () => {
    const sandbox = createSandbox("cloudflare")
    setSandboxRuntimeConfig({ provider: "cloudflare" })
    setSandboxRuntimeRegistry({ example: definition })
    runtimeMocks.createSandboxClient.mockResolvedValue(sandbox)
    runtimeMocks.executeSandboxDefinition.mockRejectedValue(new Error("definition failed"))

    const result = await runSandboxRuntime("example")

    expect(result.isErr()).toBe(true)
    expect(sandbox.stop).not.toHaveBeenCalled()
  })

  it("keeps Vercel cleanup unchanged", async () => {
    const sandbox = createSandbox("vercel")
    setSandboxRuntimeConfig({ provider: "vercel" })
    setSandboxRuntimeRegistry({ example: definition })
    runtimeMocks.createSandboxClient.mockResolvedValue(sandbox)
    runtimeMocks.executeSandboxDefinition.mockResolvedValue({ ok: true })

    const result = await runSandboxRuntime("example")

    expect(result.isOk()).toBe(true)
    expect(sandbox.stop).toHaveBeenCalledOnce()
  })
})
