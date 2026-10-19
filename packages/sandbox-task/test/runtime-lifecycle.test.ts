import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { unknownExecutionAuthority } from "@vite-hub/runtime"

const runtimeMocks = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  executeSandboxTaskDefinition: vi.fn(),
  open: vi.fn(),
  resolveProviderSandbox: vi.fn(),
  resolveTaskSandbox: vi.fn(),
  sleep: vi.fn(async () => {}),
}))

vi.mock("../src/runtime/execute.ts", () => ({
  executeSandboxTaskDefinition: runtimeMocks.executeSandboxTaskDefinition,
}))

vi.mock("../src/internal/shared/utils.ts", () => ({
  sleep: runtimeMocks.sleep,
}))

vi.mock("vitehub-sandbox-task-provider-loader", () => ({
  loadSandboxTaskRuntimeProvider: async () => ({
    resolveTaskSandbox: runtimeMocks.resolveTaskSandbox,
  }),
}))

import { resolveSandboxTaskRunner, runSandboxTaskRuntime } from "../src/runtime/runtime.ts"
import { createCloudflareExecutionSandboxId } from "../src/runtime/provider-resolution.ts"
import { sandboxTaskError } from "../src/sandbox-task/errors.ts"
import { resetSandboxTaskRuntimeState, setSandboxTaskRuntimeConfig, setSandboxTaskRuntimeRegistry } from "../src/runtime/state.ts"

const definition = {
  bundle: {
    entry: "index.mjs",
    modules: { "index.mjs": "export default async () => ({ ok: true })" },
  },
}

function createSession() {
  return {
    id: "sandbox-session",
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
  resetSandboxTaskRuntimeState()
})
beforeEach(() => {
  runtimeMocks.close.mockClear()
  runtimeMocks.executeSandboxTaskDefinition.mockReset()
  runtimeMocks.open.mockReset()
  runtimeMocks.resolveProviderSandbox.mockReset()
  runtimeMocks.resolveTaskSandbox.mockReset()
  runtimeMocks.sleep.mockClear()
  runtimeMocks.resolveTaskSandbox.mockImplementation(async ({ provider }) => ({
    closeAfterRun: provider.provider === "cloudflare" ? provider.keepAlive === true : true,
    provider: provider.provider,
    resolveSandbox: runtimeMocks.resolveProviderSandbox,
    sandboxId: provider.sandboxId,
  }))
  runtimeMocks.resolveProviderSandbox.mockResolvedValue({
    plan: { executionAuthority: unknownExecutionAuthority },
    open: runtimeMocks.open,
  })
  runtimeMocks.open.mockResolvedValue(createSession())
})

describe("Sandbox runtime lifecycle", () => {
  it("rejects inherited runtime registry definitions", async () => {
    setSandboxTaskRuntimeConfig({ provider: "cloudflare" })
    setSandboxTaskRuntimeRegistry(Object.create({ inherited: definition }))
    runtimeMocks.executeSandboxTaskDefinition.mockResolvedValue({ ok: true })

    const result = await runSandboxTaskRuntime("inherited")

    expect(result.ok).toBe(false)
    expect(await result.json()).toMatchObject({ error: { code: "SANDBOX_TASK_R0053" } })
    expect(runtimeMocks.executeSandboxTaskDefinition).not.toHaveBeenCalled()
  })
  it("creates unique valid default Cloudflare identities and preserves overrides", () => {
    const first = createCloudflareExecutionSandboxId("tools/release-notes")
    const second = createCloudflareExecutionSandboxId("tools/release-notes")
    expect(first).toMatch(/^vitehub-tools%2Fre-[a-z0-9]+-[0-9a-f-]{36}$/)
    expect(second).not.toBe(first)
    expect(createCloudflareExecutionSandboxId("tools/" + "例/".repeat(100)).length).toBeLessThanOrEqual(63)
    expect(createCloudflareExecutionSandboxId("example", "shared-sandbox")).toBe("shared-sandbox")
  })

  it("composes Cloudflare through Sandbox and closes a unique default session", async () => {
    setSandboxTaskRuntimeConfig({ provider: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition.mockResolvedValue({ ok: true })

    const result = await runSandboxTaskRuntime("example")

    expect(result.ok).toBe(true)
    expect(await result.json()).toEqual({ ok: true })
    expect(runtimeMocks.resolveProviderSandbox).toHaveBeenCalledWith(["node"])
    expect(runtimeMocks.open).toHaveBeenCalledWith({
      id: expect.stringMatching(/^vitehub-example-[a-z0-9]+-[0-9a-f-]{36}$/),
    })
    expect(runtimeMocks.close).toHaveBeenCalledOnce()
  })

  it("surfaces cleanup failures for unique default Cloudflare sessions", async () => {
    setSandboxTaskRuntimeConfig({ provider: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition.mockResolvedValue({ ok: true })
    runtimeMocks.close.mockRejectedValueOnce(new Error("destroy failed"))

    const result = await runSandboxTaskRuntime("example")

    expect(result.ok).toBe(false)
    expect(await result.json()).toMatchObject({ error: { message: "destroy failed" } })
    expect(runtimeMocks.close).toHaveBeenCalledOnce()
  })

  it("rejects removed Definition options before resolving a provider", async () => {
    setSandboxTaskRuntimeConfig({ provider: "cloudflare" })
    setSandboxTaskRuntimeRegistry({
      example: {
        ...definition,
        options: { runtime: { command: "node" } } as never,
      },
    })

    const result = await runSandboxTaskRuntime("example")

    expect(result.ok).toBe(false)
    expect(await result.json()).toMatchObject({ error: { message: expect.any(String) } })
    expect(runtimeMocks.resolveTaskSandbox).not.toHaveBeenCalled()
  })

  it("rejects invalid Definition timeouts before resolving a provider", async () => {
    setSandboxTaskRuntimeConfig({ provider: "cloudflare" })
    setSandboxTaskRuntimeRegistry({
      example: {
        ...definition,
        options: { timeout: "invalid" } as never,
      },
    })

    const result = await runSandboxTaskRuntime("example")

    expect(result.ok).toBe(false)
    expect(await result.json()).toMatchObject({ error: {
      message: "[vitehub] Sandbox Task Definition timeout must be a positive integer no greater than 2147483647.",
    } })
    expect(runtimeMocks.resolveTaskSandbox).not.toHaveBeenCalled()
  })

  it("keeps configured and per-run Cloudflare identity overrides", async () => {
    setSandboxTaskRuntimeConfig({ provider: "cloudflare", sandboxId: "configured" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition.mockResolvedValue({ ok: true })

    await runSandboxTaskRuntime("example")
    await runSandboxTaskRuntime("example", undefined, { sandboxId: "per-run" })

    expect(runtimeMocks.open).toHaveBeenNthCalledWith(1, { id: "configured" })
    expect(runtimeMocks.open).toHaveBeenNthCalledWith(2, { id: "per-run" })
  })

  it("forwards an invocation signal to Sandbox startup and execution", async () => {
    setSandboxTaskRuntimeConfig({ provider: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition.mockResolvedValue({ ok: true })
    const signal = new AbortController().signal

    const result = await runSandboxTaskRuntime("example", undefined, { signal })

    expect(result.ok).toBe(true)
    expect(runtimeMocks.open).toHaveBeenCalledWith({ id: expect.any(String), signal })
    expect(runtimeMocks.executeSandboxTaskDefinition).toHaveBeenCalledWith(
      expect.anything(),
      "example",
      undefined,
      definition.bundle,
      undefined,
      undefined,
      expect.objectContaining({ onHandlerStart: expect.any(Function) }),
      signal,
    )
  })

  it("preserves an external abort reason", async () => {
    setSandboxTaskRuntimeConfig({ provider: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    const controller = new AbortController()
    const reason = new DOMException("request disconnected", "AbortError")
    controller.abort(reason)

    await expect(runSandboxTaskRuntime("example", undefined, { signal: controller.signal })).rejects.toBe(reason)
    expect(runtimeMocks.open).not.toHaveBeenCalled()
  })

  it("runs default Cloudflare executions in distinct Sandboxes", async () => {
    setSandboxTaskRuntimeConfig({ provider: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    const releases: Array<() => void> = []
    runtimeMocks.executeSandboxTaskDefinition.mockImplementation(async () => await new Promise(resolve => {
      releases.push(() => resolve({ ok: true }))
    }))

    const runner = await resolveSandboxTaskRunner("example")
    expect(runner.executionAuthority).toBe(unknownExecutionAuthority)
    const first = runner.run()
    const second = runner.run()
    await vi.waitFor(() => expect(runtimeMocks.open).toHaveBeenCalledTimes(2))
    expect(runtimeMocks.open.mock.calls[0]?.[0]?.id).not.toBe(runtimeMocks.open.mock.calls[1]?.[0]?.id)
    releases.splice(0).forEach(release => release())
    await Promise.all([first, second])

    expect(runtimeMocks.close).toHaveBeenCalledTimes(2)
  })

  it("keeps an aborted queued run from releasing a shared Sandbox slot early", async () => {
    setSandboxTaskRuntimeConfig({ provider: "cloudflare", sandboxId: "shared" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    const releases: Array<() => void> = []
    runtimeMocks.executeSandboxTaskDefinition.mockImplementation(async () => await new Promise(resolve => {
      releases.push(() => resolve({ ok: true }))
    }))

    const runner = await resolveSandboxTaskRunner("example")
    const first = runner.run()
    await vi.waitFor(() => expect(runtimeMocks.open).toHaveBeenCalledOnce())
    expect(runtimeMocks.open).toHaveBeenCalledWith({ id: "shared" })

    const controller = new AbortController()
    const second = runner.run(undefined, { signal: controller.signal })
    const reason = new DOMException("request disconnected", "AbortError")
    controller.abort(reason)
    await expect(second).rejects.toBe(reason)

    const third = runner.run()
    await Promise.resolve()
    expect(runtimeMocks.open).toHaveBeenCalledOnce()

    releases.shift()?.()
    await expect(first).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(runtimeMocks.open).toHaveBeenCalledTimes(2))
    releases.shift()?.()
    await expect(third).resolves.toEqual({ ok: true })
  })

  it("holds an actively cancelled shared Sandbox until execution and destruction settle", async () => {
    setSandboxTaskRuntimeConfig({ provider: "cloudflare", sandboxId: "active-cancellation" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    let finishExecution!: () => void
    const execution = new Promise<void>(resolve => { finishExecution = resolve })
    let finishDestruction!: () => void
    const destruction = new Promise<void>(resolve => { finishDestruction = resolve })
    runtimeMocks.close.mockImplementationOnce(async () => await destruction)
    runtimeMocks.executeSandboxTaskDefinition
      .mockImplementationOnce(async (...args) => {
        const lifecycle = args[6] as { onExecution: (execution: Promise<unknown>) => void }
        const signal = args[7] as AbortSignal
        lifecycle.onExecution(execution)
        await new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      })
      .mockResolvedValueOnce({ ok: true })

    const runner = await resolveSandboxTaskRunner("example")
    const controller = new AbortController()
    const first = runner.run(undefined, { signal: controller.signal })
    await vi.waitFor(() => expect(runtimeMocks.executeSandboxTaskDefinition).toHaveBeenCalledOnce())
    const reason = new DOMException("request disconnected", "AbortError")
    controller.abort(reason)
    await expect(first).rejects.toBe(reason)

    const next = runner.run()
    await Promise.resolve()
    expect(runtimeMocks.open).toHaveBeenCalledOnce()
    expect(runtimeMocks.close).not.toHaveBeenCalled()
    finishExecution()
    await vi.waitFor(() => expect(runtimeMocks.close).toHaveBeenCalledOnce())
    expect(runtimeMocks.open).toHaveBeenCalledOnce()
    finishDestruction()
    await expect(next).resolves.toEqual({ ok: true })
    expect(runtimeMocks.open).toHaveBeenCalledTimes(2)
  })

  it("closes the Sandbox session after failed definitions", async () => {
    setSandboxTaskRuntimeConfig({ provider: "vercel" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition.mockRejectedValue(new Error("definition failed"))

    const result = await runSandboxTaskRuntime("example")

    expect(result.ok).toBe(false)
    expect(await result.json()).toMatchObject({ error: { message: expect.any(String) } })
    expect(runtimeMocks.close).toHaveBeenCalledOnce()
  })

  it("does not replay timed out Cloudflare definitions", async () => {
    setSandboxTaskRuntimeConfig({ provider: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition.mockRejectedValue(sandboxTaskError("definition timed out", {
      code: "SANDBOX_TASK_TIMEOUT",
      provider: "cloudflare",
    }))

    const result = await runSandboxTaskRuntime("example")

    expect(result.ok).toBe(false)
    expect(result.status).toBe(504)
    expect(await result.json()).toMatchObject({ error: { code: "SANDBOX_TASK_TIMEOUT" } })
    expect(runtimeMocks.executeSandboxTaskDefinition).toHaveBeenCalledOnce()
    expect(runtimeMocks.close).toHaveBeenCalledOnce()
  })

  it("does not replay Cloudflare definitions whose handler errors look transient", async () => {
    setSandboxTaskRuntimeConfig({ provider: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition.mockImplementation(async (...args) => {
      const lifecycle = args[6] as { onHandlerStart?: () => void }
      lifecycle.onHandlerStart?.()
      throw sandboxTaskError("[vitehub] Cloudflare Sandbox exists timed out after 15000ms.", {
        code: "SANDBOX_TASK_HANDLER_ERROR",
        provider: "cloudflare",
      })
    })

    const result = await runSandboxTaskRuntime("example")

    expect(result.ok).toBe(false)
    expect(await result.json()).toMatchObject({ error: { code: "SANDBOX_TASK_HANDLER_ERROR" } })
    expect(runtimeMocks.open).toHaveBeenCalledOnce()
    expect(runtimeMocks.executeSandboxTaskDefinition).toHaveBeenCalledOnce()
    expect(runtimeMocks.sleep).not.toHaveBeenCalled()
    expect(runtimeMocks.close).toHaveBeenCalledOnce()
  })

  it("retries transient Cloudflare failures while Definition staging is still safe", async () => {
    setSandboxTaskRuntimeConfig({ provider: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition
      .mockRejectedValueOnce(new Error("[vitehub] Cloudflare Sandbox exists failed: [vitehub] Cloudflare Sandbox exists timed out after 15000ms."))
      .mockImplementationOnce(async (...args) => {
        const lifecycle = args[6] as { onHandlerStart?: () => void }
        lifecycle.onHandlerStart?.()
        return { ok: true }
      })

    const result = await runSandboxTaskRuntime("example")

    expect(result.ok).toBe(true)
    expect(await result.json()).toEqual({ ok: true })
    expect(runtimeMocks.open).toHaveBeenCalledTimes(2)
    expect(runtimeMocks.executeSandboxTaskDefinition).toHaveBeenCalledTimes(2)
    expect(runtimeMocks.sleep).toHaveBeenCalledWith(1000)
    expect(runtimeMocks.close).toHaveBeenCalledTimes(2)
  })

  it("retries Cloudflare initialization timeouts even when cleanup also times out", async () => {
    setSandboxTaskRuntimeConfig({ provider: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.open
      .mockRejectedValueOnce(new AggregateError(
        [
          new Error("[vitehub] Cloudflare Sandbox exists timed out after 15000ms."),
          new Error("[vitehub] Cloudflare Sandbox destroy timed out after 10000ms."),
        ],
        "[vitehub] cloudflare Sandbox initialization failed: [vitehub] Cloudflare Sandbox exists timed out after 15000ms. Cleanup failed: [vitehub] Cloudflare Sandbox destroy timed out after 10000ms.",
      ))
      .mockResolvedValueOnce(createSession())
    runtimeMocks.executeSandboxTaskDefinition.mockResolvedValue({ ok: true })

    const result = await runSandboxTaskRuntime("example")

    expect(result.ok).toBe(true)
    expect(await result.json()).toEqual({ ok: true })
    expect(runtimeMocks.open).toHaveBeenCalledTimes(2)
    expect(runtimeMocks.executeSandboxTaskDefinition).toHaveBeenCalledOnce()
    expect(runtimeMocks.sleep).toHaveBeenCalledWith(1000)
    expect(runtimeMocks.close).toHaveBeenCalledOnce()
  })

  it("retries transient Cloudflare failures before Definition execution starts", async () => {
    setSandboxTaskRuntimeConfig({ provider: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.open
      .mockRejectedValueOnce(new Error("container is starting"))
      .mockResolvedValueOnce(createSession())
    runtimeMocks.executeSandboxTaskDefinition.mockResolvedValue({ ok: true })

    const result = await runSandboxTaskRuntime("example")

    expect(result.ok).toBe(true)
    expect(await result.json()).toEqual({ ok: true })
    expect(runtimeMocks.open).toHaveBeenCalledTimes(2)
    expect(runtimeMocks.executeSandboxTaskDefinition).toHaveBeenCalledOnce()
    expect(runtimeMocks.sleep).toHaveBeenCalledWith(1000)
    expect(runtimeMocks.close).toHaveBeenCalledOnce()
  })

  it("closes Cloudflare when keepAlive disables idle shutdown", async () => {
    setSandboxTaskRuntimeConfig({ provider: "cloudflare", keepAlive: true })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition.mockResolvedValue({ ok: true })

    const result = await runSandboxTaskRuntime("example")

    expect(result.ok).toBe(true)
    expect(await result.json()).toEqual({ ok: true })
    expect(runtimeMocks.close).toHaveBeenCalledOnce()
  })

  it("declares the project package manager as a Sandbox requirement", async () => {
    setSandboxTaskRuntimeConfig({ provider: "vercel" })
    setSandboxTaskRuntimeRegistry({
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
    runtimeMocks.executeSandboxTaskDefinition.mockResolvedValue({ ok: true })

    await runSandboxTaskRuntime("example")

    expect(runtimeMocks.resolveProviderSandbox).toHaveBeenCalledWith(["node", "pnpm"])
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
    setSandboxTaskRuntimeConfig({ provider: "vercel" })
    setSandboxTaskRuntimeRegistry({ example: packageDefinition })
    runtimeMocks.executeSandboxTaskDefinition.mockResolvedValue({ ok: true })

    const result = await runSandboxTaskRuntime("example")

    expect(result.ok).toBe(true)
    expect(await result.json()).toEqual({ ok: true })
    expect(runtimeMocks.executeSandboxTaskDefinition).toHaveBeenCalledWith(
      expect.anything(),
      "example",
      undefined,
      packageDefinition.bundle,
      undefined,
      undefined,
      expect.objectContaining({ onHandlerStart: expect.any(Function) }),
    )
  })
})
