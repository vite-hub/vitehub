import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { unknownExecutionAuthority } from "@vite-hub/runtime"

const runtimeMocks = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  executeSandboxDefinition: vi.fn(),
  open: vi.fn(),
  resolveProviderBox: vi.fn(),
  resolveSandboxBox: vi.fn(),
}))

vi.mock("../src/runtime/execute.ts", () => ({
  executeSandboxDefinition: runtimeMocks.executeSandboxDefinition,
}))

vi.mock("vitehub-sandbox-provider-loader", () => ({
  loadSandboxRuntimeProvider: async () => ({
    resolveSandboxBox: runtimeMocks.resolveSandboxBox,
  }),
}))

import { resolveSandboxRunner, runSandboxRuntime } from "../src/runtime/runtime.ts"
import { createCloudflareExecutionSandboxId } from "../src/runtime/provider-resolution.ts"
import { resetSandboxRuntimeState, setSandboxRuntimeConfig, setSandboxRuntimeRegistry } from "../src/runtime/state.ts"

const definition = {
  bundle: {
    entry: "index.mjs",
    modules: { "index.mjs": "export default async () => ({ ok: true })" },
  },
}

function createSession() {
  return {
    id: "box-session",
    cwd: "/workspace",
    executionAuthority: unknownExecutionAuthority,
    files: {
      exists: vi.fn(),
      list: vi.fn(),
      mkdir: vi.fn(),
      read: vi.fn(),
      remove: vi.fn(),
      write: vi.fn(),
    },
    exec: vi.fn(),
    close: runtimeMocks.close,
  }
}

afterEach(() => {
  resetSandboxRuntimeState()
})
beforeEach(() => {
  runtimeMocks.close.mockClear()
  runtimeMocks.executeSandboxDefinition.mockReset()
  runtimeMocks.open.mockReset()
  runtimeMocks.resolveProviderBox.mockReset()
  runtimeMocks.resolveSandboxBox.mockReset()
  runtimeMocks.resolveSandboxBox.mockImplementation(async ({ provider }) => ({
    closeAfterRun: provider.provider === "cloudflare" ? provider.keepAlive === true : true,
    provider: provider.provider,
    resolveBox: runtimeMocks.resolveProviderBox,
    sandboxId: provider.sandboxId,
  }))
  runtimeMocks.resolveProviderBox.mockResolvedValue({
    plan: { executionAuthority: unknownExecutionAuthority },
    open: runtimeMocks.open,
  })
  runtimeMocks.open.mockResolvedValue(createSession())
})

describe("Sandbox runtime lifecycle", () => {
  it("keeps distinct Definition names distinct in default Cloudflare identities", () => {
    expect(createCloudflareExecutionSandboxId("tools/release-notes")).toMatch(/^vitehub-tools%2Frelease-notes-[a-z0-9]+-definition$/)
    expect(createCloudflareExecutionSandboxId("api")).toMatch(/^vitehub-api-[a-z0-9]+-definition$/)
    expect(createCloudflareExecutionSandboxId("tools/release-notes"))
      .not.toBe(createCloudflareExecutionSandboxId("tools_release-notes"))
    expect(createCloudflareExecutionSandboxId("Example").toLowerCase())
      .not.toBe(createCloudflareExecutionSandboxId("example").toLowerCase())
    expect(createCloudflareExecutionSandboxId("tools/" + "例/".repeat(100))).toHaveLength(256)
  })

  it("composes Cloudflare through Box and leaves the session to idle shutdown", async () => {
    setSandboxRuntimeConfig({ provider: "cloudflare" })
    setSandboxRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxDefinition.mockResolvedValue({ ok: true })

    const result = await runSandboxRuntime("example")

    expect(result[0]).toBeNull()
    expect(runtimeMocks.resolveProviderBox).toHaveBeenCalledWith(["node"])
    expect(runtimeMocks.open).toHaveBeenCalledWith({
      id: expect.stringMatching(/^vitehub-example-[a-z0-9]+-definition$/),
    })
    expect(runtimeMocks.close).not.toHaveBeenCalled()
  })

  it("rejects removed Definition options before resolving a provider", async () => {
    setSandboxRuntimeConfig({ provider: "cloudflare" })
    setSandboxRuntimeRegistry({
      example: {
        ...definition,
        options: { runtime: { command: "node" } } as never,
      },
    })

    const result = await runSandboxRuntime("example")

    expect(result[0]).toBeInstanceOf(Error)
    expect(runtimeMocks.resolveSandboxBox).not.toHaveBeenCalled()
  })

  it("keeps configured and per-run Cloudflare identity overrides", async () => {
    setSandboxRuntimeConfig({ provider: "cloudflare", sandboxId: "configured" })
    setSandboxRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxDefinition.mockResolvedValue({ ok: true })

    await runSandboxRuntime("example")
    await runSandboxRuntime("example", undefined, { sandboxId: "per-run" })

    expect(runtimeMocks.open).toHaveBeenNthCalledWith(1, { id: "configured" })
    expect(runtimeMocks.open).toHaveBeenNthCalledWith(2, { id: "per-run" })
  })

  it("serializes concurrent runs that share a Cloudflare Box", async () => {
    setSandboxRuntimeConfig({ provider: "cloudflare" })
    setSandboxRuntimeRegistry({ example: definition })
    const releases: Array<() => void> = []
    runtimeMocks.executeSandboxDefinition.mockImplementation(async () => await new Promise(resolve => {
      releases.push(() => resolve({ ok: true }))
    }))

    const runner = await resolveSandboxRunner("example")
    expect(runner.executionAuthority).toBe(unknownExecutionAuthority)
    const first = runner.run()
    const second = runner.run()
    await vi.waitFor(() => expect(runtimeMocks.open).toHaveBeenCalledOnce())
    releases.shift()?.()
    await vi.waitFor(() => expect(runtimeMocks.open).toHaveBeenCalledTimes(2))
    expect(runtimeMocks.open.mock.calls[0]?.[0]?.id).toBe(runtimeMocks.open.mock.calls[1]?.[0]?.id)
    releases.shift()?.()
    await Promise.all([first, second])

    expect(runtimeMocks.close).not.toHaveBeenCalled()
  })

  it("closes the Box session after failed definitions", async () => {
    setSandboxRuntimeConfig({ provider: "vercel" })
    setSandboxRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxDefinition.mockRejectedValue(new Error("definition failed"))

    const result = await runSandboxRuntime("example")

    expect(result[0]).toBeInstanceOf(Error)
    expect(runtimeMocks.close).toHaveBeenCalledOnce()
  })

  it("closes Cloudflare when keepAlive disables idle shutdown", async () => {
    setSandboxRuntimeConfig({ provider: "cloudflare", keepAlive: true })
    setSandboxRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxDefinition.mockResolvedValue({ ok: true })

    const result = await runSandboxRuntime("example")

    expect(result[0]).toBeNull()
    expect(runtimeMocks.close).toHaveBeenCalledOnce()
  })

  it("declares the project package manager as a Box requirement", async () => {
    setSandboxRuntimeConfig({ provider: "vercel" })
    setSandboxRuntimeRegistry({
      example: {
        bundle: {
          ...definition.bundle,
          project: {
            digest: "a".repeat(64),
            files: {},
            install: { args: ["install"], command: "pnpm", cwd: "." },
            packagePath: ".",
          },
        },
      },
    })
    runtimeMocks.executeSandboxDefinition.mockResolvedValue({ ok: true })

    await runSandboxRuntime("example")

    expect(runtimeMocks.resolveProviderBox).toHaveBeenCalledWith(["node", "pnpm"])
  })

  it("accepts package entries stored in project files", async () => {
    const packageDefinition = {
      bundle: {
        entry: "sandboxes/example/index.ts",
        execution: "module" as const,
        modules: {},
        project: {
          digest: "a".repeat(64),
          files: {
            "sandboxes/example/index.ts": {
              contents: Buffer.from("export default { ok: true }").toString("base64"),
              encoding: "base64" as const,
            },
          },
          install: { args: ["install"], command: "npm" as const, cwd: "." },
          packagePath: "sandboxes/example",
        },
      },
    }
    setSandboxRuntimeConfig({ provider: "vercel" })
    setSandboxRuntimeRegistry({ example: packageDefinition })
    runtimeMocks.executeSandboxDefinition.mockResolvedValue({ ok: true })

    const result = await runSandboxRuntime("example")

    expect(result[0]).toBeNull()
    expect(runtimeMocks.executeSandboxDefinition).toHaveBeenCalledWith(
      expect.anything(),
      "example",
      undefined,
      packageDefinition.bundle,
      undefined,
      undefined,
    )
  })
})
