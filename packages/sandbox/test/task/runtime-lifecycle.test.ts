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

vi.mock("../../src/task/runtime/execute.ts", () => ({
  executeSandboxTaskDefinition: runtimeMocks.executeSandboxTaskDefinition,
}))

vi.mock("../../src/task/internal/shared/utils.ts", () => ({
  sleep: runtimeMocks.sleep,
}))

vi.mock("#vitehub-sandbox-task-provider-loader", () => ({
  loadSandboxTaskRuntimeProvider: async () => ({
    resolveTaskSandbox: runtimeMocks.resolveTaskSandbox,
  }),
}))

import { resolveSandboxTaskRunner, runSandboxTaskRuntime } from "../../src/task/runtime/runtime.ts"
import { createCloudflareExecutionSandboxId } from "../../src/task/runtime/provider-resolution.ts"
import { sandboxTaskError } from "../../src/task/sandbox-task/errors.ts"
import { sandboxErrorDiagnostics } from "../../src/error-diagnostics.ts"
import { resetSandboxTaskRuntimeState, setSandboxTaskRuntimeConfig, setSandboxTaskRuntimeRegistry } from "../../src/task/runtime/state.ts"

const definition = {
  bundle: {
    entry: "index.mjs",
    modules: { "index.mjs": "export default async () => ({ ok: true })" },
  },
}

function cloudflareRequestError(operation: string, cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause)
  return sandboxErrorDiagnostics.SANDBOX_R0088({ message: `[vitehub] Cloudflare Sandbox ${operation} failed: ${message}`, cause, retryable: undefined })
}

function cloudflareDeadlineError(operation: string, timeout: number) {
  return cloudflareRequestError(operation, sandboxErrorDiagnostics.SANDBOX_R0090({ message: `[vitehub] Cloudflare Sandbox ${operation} timed out after ${timeout}ms.` }))
}

function hostError(message: string, flags: { overloaded?: boolean, retryable?: boolean }) {
  return Object.assign(new Error(message), flags)
}

function startCommandThenThrow(error: unknown) {
  return async (...args: unknown[]) => {
    const lifecycle = args[6] as { onCommandStart?: () => void }
    lifecycle.onCommandStart?.()
    throw error
  }
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
    provider: provider.driver,
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
    setSandboxTaskRuntimeConfig({ driver: "cloudflare" })
    setSandboxTaskRuntimeRegistry(Object.create({ inherited: definition }))
    runtimeMocks.executeSandboxTaskDefinition.mockResolvedValue({ ok: true })

    const result = await runSandboxTaskRuntime("inherited")

    expect(result[0]?.code).toBe("SANDBOX_TASK_RUN_FAILED")
    expect(result[0]?.cause).toMatchObject({ code: "SANDBOX_TASK_R0053" })
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
    setSandboxTaskRuntimeConfig({ driver: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition.mockResolvedValue({ ok: true })

    const result = await runSandboxTaskRuntime("example")

    expect(result[0]).toBeUndefined()
    expect(result[1]).toEqual({ ok: true })
    expect(runtimeMocks.resolveProviderSandbox).toHaveBeenCalledWith(["node"])
    expect(runtimeMocks.open).toHaveBeenCalledWith({
      id: expect.stringMatching(/^vitehub-example-[a-z0-9]+-[0-9a-f-]{36}$/),
    })
    expect(runtimeMocks.close).toHaveBeenCalledOnce()
  })

  it("surfaces cleanup failures for unique default Cloudflare sessions", async () => {
    setSandboxTaskRuntimeConfig({ driver: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition.mockResolvedValue({ ok: true })
    runtimeMocks.close.mockRejectedValueOnce(new Error("destroy failed"))

    const result = await runSandboxTaskRuntime("example")

    expect(result[0]?.code).toBe("SANDBOX_TASK_RUN_FAILED")
    expect(result[0]?.cause).toMatchObject({ message: "destroy failed" })
    expect(runtimeMocks.close).toHaveBeenCalledOnce()
  })

  it("rejects removed Definition options before resolving a provider", async () => {
    setSandboxTaskRuntimeConfig({ driver: "cloudflare" })
    setSandboxTaskRuntimeRegistry({
      example: {
        ...definition,
        options: { runtime: { command: "node" } } as never,
      },
    })

    const result = await runSandboxTaskRuntime("example")

    expect(result[0]?.code).toBe("SANDBOX_TASK_RUN_FAILED")
    expect(result[0]?.cause).toMatchObject({ message: expect.any(String) })
    expect(runtimeMocks.resolveTaskSandbox).not.toHaveBeenCalled()
  })

  it("rejects invalid Definition timeouts before resolving a provider", async () => {
    setSandboxTaskRuntimeConfig({ driver: "cloudflare" })
    setSandboxTaskRuntimeRegistry({
      example: {
        ...definition,
        options: { timeout: "invalid" } as never,
      },
    })

    const result = await runSandboxTaskRuntime("example")

    expect(result[0]?.code).toBe("SANDBOX_TASK_RUN_FAILED")
    expect(result[0]?.cause).toMatchObject({
      message: "[vitehub] Sandbox Task Definition timeout must be a positive integer no greater than 2147483647.",
    })
    expect(runtimeMocks.resolveTaskSandbox).not.toHaveBeenCalled()
  })

  it.each([
    { transfer: 1, why: "must be an object" },
    { transfer: true, why: "must be an object" },
    { transfer: "invalid", why: "must be an object" },
    { transfer: [], why: "must be an object" },
    { transfer: { maxBytes: 1 }, why: "Unsupported: maxBytes" },
    { transfer: { maxDepth: 0 }, why: "sets maxDepth to 0" },
    { transfer: { maxSidecars: 1.5 }, why: "sets maxSidecars to 1.5" },
    { transfer: { maxInputBytes: "1024" }, why: "sets maxInputBytes to 1024" },
    { transfer: { maxOutputBytes: 1_073_741_825 }, why: "sets maxOutputBytes to 1073741825" },
  ])("rejects the invalid transfer option $transfer before resolving a provider", async ({ transfer, why }) => {
    setSandboxTaskRuntimeConfig({ driver: "cloudflare" })
    setSandboxTaskRuntimeRegistry({
      example: {
        ...definition,
        options: { transfer } as never,
      },
    })

    const result = await runSandboxTaskRuntime("example")

    expect(result[0]?.code).toBe("SANDBOX_TASK_RUN_FAILED")
    expect(result[0]?.cause).toMatchObject({
      code: "SANDBOX_TASK_TRANSFER_INVALID",
      message: expect.stringContaining(why),
    })
    expect(runtimeMocks.resolveTaskSandbox).not.toHaveBeenCalled()
    expect(runtimeMocks.executeSandboxTaskDefinition).not.toHaveBeenCalled()
  })

  it("passes valid transfer options to the execution", async () => {
    const transfer = { maxInputBytes: 1, maxOutputBytes: 1_073_741_824, maxDepth: 8, maxSidecars: 2, maxSidecarBytes: 1024 }
    setSandboxTaskRuntimeConfig({ driver: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: { ...definition, options: { transfer } } })
    runtimeMocks.executeSandboxTaskDefinition.mockResolvedValue({ ok: true })

    const result = await runSandboxTaskRuntime("example")

    expect(result[0]).toBeUndefined()
    expect(runtimeMocks.executeSandboxTaskDefinition.mock.calls[0]?.[2]).toEqual({ timeout: 300_000, transfer })
  })

  it("keeps configured and per-run Cloudflare identity overrides", async () => {
    setSandboxTaskRuntimeConfig({ driver: "cloudflare", sandboxId: "configured" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition.mockResolvedValue({ ok: true })

    await runSandboxTaskRuntime("example")
    await runSandboxTaskRuntime("example", undefined, { sandboxId: "per-run" })

    expect(runtimeMocks.open).toHaveBeenNthCalledWith(1, { id: "configured" })
    expect(runtimeMocks.open).toHaveBeenNthCalledWith(2, { id: "per-run" })
  })

  it("forwards an invocation signal and the default timeout to Sandbox startup and execution", async () => {
    setSandboxTaskRuntimeConfig({ driver: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition.mockResolvedValue({ ok: true })
    const signal = new AbortController().signal

    const result = await runSandboxTaskRuntime("example", undefined, { signal })

    expect(result[0]).toBeUndefined()
    expect(runtimeMocks.open).toHaveBeenCalledWith({ id: expect.any(String), signal })
    expect(runtimeMocks.resolveTaskSandbox).toHaveBeenCalledWith(expect.objectContaining({ local: { timeout: 300_000 } }))
    expect(runtimeMocks.executeSandboxTaskDefinition).toHaveBeenCalledWith(
      expect.anything(),
      "example",
      { timeout: 300_000 },
      definition.bundle,
      undefined,
      undefined,
      expect.objectContaining({ onCommandStart: expect.any(Function) }),
      signal,
    )
  })

  it("preserves an external abort reason", async () => {
    setSandboxTaskRuntimeConfig({ driver: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    const controller = new AbortController()
    const reason = new DOMException("request disconnected", "AbortError")
    controller.abort(reason)

    await expect(runSandboxTaskRuntime("example", undefined, { signal: controller.signal })).rejects.toBe(reason)
    expect(runtimeMocks.open).not.toHaveBeenCalled()
  })

  it("runs default Cloudflare executions in distinct Sandboxes", async () => {
    setSandboxTaskRuntimeConfig({ driver: "cloudflare" })
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
    setSandboxTaskRuntimeConfig({ driver: "cloudflare", sandboxId: "shared" })
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
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(runtimeMocks.open).toHaveBeenCalledOnce()

    releases.shift()?.()
    await expect(first).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(runtimeMocks.open).toHaveBeenCalledTimes(2))
    releases.shift()?.()
    await expect(third).resolves.toEqual({ ok: true })
  })

  it("holds an actively cancelled shared Sandbox until execution settles, and keeps it open", async () => {
    setSandboxTaskRuntimeConfig({ driver: "cloudflare", sandboxId: "active-cancellation" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    let finishExecution!: () => void
    const execution = new Promise<void>(resolve => { finishExecution = resolve })
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
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(runtimeMocks.open).toHaveBeenCalledOnce()
    expect(runtimeMocks.close).not.toHaveBeenCalled()
    finishExecution()
    await expect(next).resolves.toEqual({ ok: true })
    expect(runtimeMocks.open).toHaveBeenCalledTimes(2)
    expect(runtimeMocks.close).not.toHaveBeenCalled()
  })

  it("closes the Sandbox session after failed definitions", async () => {
    setSandboxTaskRuntimeConfig({ driver: "vercel" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition.mockRejectedValue(new Error("definition failed"))

    const result = await runSandboxTaskRuntime("example")

    expect(result[0]?.code).toBe("SANDBOX_TASK_RUN_FAILED")
    expect(result[0]?.cause).toMatchObject({ message: expect.any(String) })
    expect(runtimeMocks.close).toHaveBeenCalledOnce()
  })

  it("does not replay timed out Cloudflare definitions", async () => {
    setSandboxTaskRuntimeConfig({ driver: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition.mockRejectedValue(sandboxTaskError("definition timed out", {
      code: "SANDBOX_TASK_TIMEOUT",
      provider: "cloudflare",
    }))

    const result = await runSandboxTaskRuntime("example")

    expect(result[0]?.code).toBe("SANDBOX_TASK_RUN_FAILED")
    expect(result[0]?.status).toBe(504)
    expect(result[0]?.cause).toMatchObject({ code: "SANDBOX_TASK_TIMEOUT" })
    expect(runtimeMocks.executeSandboxTaskDefinition).toHaveBeenCalledOnce()
    expect(runtimeMocks.close).toHaveBeenCalledOnce()
  })

  it.each(["container is starting", "Network connection lost."])("does not replay handler errors containing %s", async (message) => {
    setSandboxTaskRuntimeConfig({ driver: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition.mockImplementation(async (...args) => {
      const lifecycle = args[6] as { onCommandStart?: () => void }
      lifecycle.onCommandStart?.()
      throw sandboxTaskError(message, {
        code: "SANDBOX_TASK_HANDLER_ERROR",
        provider: "cloudflare",
      })
    })

    const result = await runSandboxTaskRuntime("example")

    expect(result[0]?.code).toBe("SANDBOX_TASK_RUN_FAILED")
    expect(result[0]?.cause).toMatchObject({ code: "SANDBOX_TASK_HANDLER_ERROR" })
    expect(runtimeMocks.open).toHaveBeenCalledOnce()
    expect(runtimeMocks.executeSandboxTaskDefinition).toHaveBeenCalledOnce()
    expect(runtimeMocks.sleep).not.toHaveBeenCalled()
    expect(runtimeMocks.close).toHaveBeenCalledOnce()
  })

  it("retries transient Cloudflare failures while Definition staging is still safe", async () => {
    setSandboxTaskRuntimeConfig({ driver: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition
      .mockRejectedValueOnce(cloudflareDeadlineError("exists", 15000))
      .mockImplementationOnce(async (...args) => {
        const lifecycle = args[6] as { onCommandStart?: () => void }
        lifecycle.onCommandStart?.()
        return { ok: true }
      })

    const result = await runSandboxTaskRuntime("example")

    expect(result[0]).toBeUndefined()
    expect(result[1]).toEqual({ ok: true })
    expect(runtimeMocks.open).toHaveBeenCalledTimes(2)
    expect(runtimeMocks.executeSandboxTaskDefinition).toHaveBeenCalledTimes(2)
    expect(runtimeMocks.sleep).toHaveBeenCalledWith(1000)
    expect(runtimeMocks.close).toHaveBeenCalledTimes(2)
  })

  it("retries Cloudflare initialization timeouts even when cleanup also times out", async () => {
    setSandboxTaskRuntimeConfig({ driver: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.open
      .mockRejectedValueOnce(new AggregateError(
        [
          cloudflareDeadlineError("exists", 15000),
          cloudflareDeadlineError("destroy", 10000),
        ],
        "[vitehub] cloudflare Sandbox initialization failed: [vitehub] Cloudflare Sandbox exists timed out after 15000ms. Cleanup failed: [vitehub] Cloudflare Sandbox destroy timed out after 10000ms.",
      ))
      .mockResolvedValueOnce(createSession())
    runtimeMocks.executeSandboxTaskDefinition.mockResolvedValue({ ok: true })

    const result = await runSandboxTaskRuntime("example")

    expect(result[0]).toBeUndefined()
    expect(result[1]).toEqual({ ok: true })
    expect(runtimeMocks.open).toHaveBeenCalledTimes(2)
    expect(runtimeMocks.executeSandboxTaskDefinition).toHaveBeenCalledOnce()
    expect(runtimeMocks.sleep).toHaveBeenCalledWith(1000)
    expect(runtimeMocks.close).toHaveBeenCalledOnce()
  })

  it("does not retry a Cloudflare command that reached its exec deadline before the handler started", async () => {
    setSandboxTaskRuntimeConfig({ driver: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition.mockImplementation(startCommandThenThrow(cloudflareDeadlineError("exec", 180000)))

    const result = await runSandboxTaskRuntime("example")

    expect(result[0]?.code).toBe("SANDBOX_TASK_RUN_FAILED")
    expect(result[0]?.cause).toMatchObject({ message: expect.stringContaining("exec timed out after 180000ms") })
    expect(runtimeMocks.executeSandboxTaskDefinition).toHaveBeenCalledOnce()
    expect(runtimeMocks.sleep).not.toHaveBeenCalled()
  })

  it("does not rerun the Task when the connection is lost after a command started", async () => {
    setSandboxTaskRuntimeConfig({ driver: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition.mockImplementation(startCommandThenThrow(
      cloudflareRequestError("exec", hostError("Network connection lost.", { retryable: true })),
    ))

    const result = await runSandboxTaskRuntime("example")

    expect(result[0]?.code).toBe("SANDBOX_TASK_RUN_FAILED")
    expect(result[0]?.cause).toMatchObject({ message: expect.stringContaining("Network connection lost.") })
    expect(runtimeMocks.open).toHaveBeenCalledOnce()
    expect(runtimeMocks.executeSandboxTaskDefinition).toHaveBeenCalledOnce()
    expect(runtimeMocks.sleep).not.toHaveBeenCalled()
  })

  it("does not rerun the Task after command cold-start retries are exhausted", async () => {
    setSandboxTaskRuntimeConfig({ driver: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition
      .mockImplementationOnce(startCommandThenThrow(
        cloudflareRequestError("exec", new Error("The container is starting. Please retry in a moment.")),
      ))
      .mockResolvedValueOnce({ ok: true })

    const result = await runSandboxTaskRuntime("example")

    expect(result[0]?.code).toBe("SANDBOX_TASK_RUN_FAILED")
    expect(runtimeMocks.executeSandboxTaskDefinition).toHaveBeenCalledOnce()
    expect(runtimeMocks.sleep).not.toHaveBeenCalled()
  })

  it("does not repeat a successful install when a later command gets a cold start", async () => {
    setSandboxTaskRuntimeConfig({ driver: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    const install = vi.fn()
    runtimeMocks.executeSandboxTaskDefinition.mockImplementation(async (...args) => {
      const lifecycle = args[6] as { onCommandStart: () => void }
      lifecycle.onCommandStart()
      install()
      lifecycle.onCommandStart()
      throw cloudflareRequestError("exec", new Error("container is starting"))
    })

    const result = await runSandboxTaskRuntime("example")

    expect(result[0]?.code).toBe("SANDBOX_TASK_RUN_FAILED")
    expect(install).toHaveBeenCalledOnce()
    expect(runtimeMocks.open).toHaveBeenCalledOnce()
    expect(runtimeMocks.sleep).not.toHaveBeenCalled()
  })

  it.each([
    { flags: { overloaded: true, retryable: true }, name: "an overloaded Durable Object" },
    { flags: { retryable: false }, name: "a non-retryable failure" },
  ])("does not rerun the Task before any command for $name", async ({ flags }) => {
    setSandboxTaskRuntimeConfig({ driver: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition.mockRejectedValue(
      cloudflareRequestError("writeFile", hostError("Network connection lost.", flags)),
    )

    const result = await runSandboxTaskRuntime("example")

    expect(result[0]?.code).toBe("SANDBOX_TASK_RUN_FAILED")
    expect(runtimeMocks.executeSandboxTaskDefinition).toHaveBeenCalledOnce()
    expect(runtimeMocks.sleep).not.toHaveBeenCalled()
  })

  it("reruns the Task when the host marks a failure before any command retryable", async () => {
    setSandboxTaskRuntimeConfig({ driver: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition
      .mockRejectedValueOnce(cloudflareRequestError("writeFile", hostError("Internal error in Durable Object storage.", { retryable: true })))
      .mockResolvedValueOnce({ ok: true })

    const result = await runSandboxTaskRuntime("example")

    expect(result[0]).toBeUndefined()
    expect(runtimeMocks.executeSandboxTaskDefinition).toHaveBeenCalledTimes(2)
  })

  it("retries transient Cloudflare failures before Definition execution starts", async () => {
    setSandboxTaskRuntimeConfig({ driver: "cloudflare" })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.open
      .mockRejectedValueOnce(new Error("container is starting"))
      .mockResolvedValueOnce(createSession())
    runtimeMocks.executeSandboxTaskDefinition.mockResolvedValue({ ok: true })

    const result = await runSandboxTaskRuntime("example")

    expect(result[0]).toBeUndefined()
    expect(result[1]).toEqual({ ok: true })
    expect(runtimeMocks.open).toHaveBeenCalledTimes(2)
    expect(runtimeMocks.executeSandboxTaskDefinition).toHaveBeenCalledOnce()
    expect(runtimeMocks.sleep).toHaveBeenCalledWith(1000)
    expect(runtimeMocks.close).toHaveBeenCalledOnce()
  })

  it("closes a Cloudflare Sandbox without an ID after the run, also with keepAlive", async () => {
    setSandboxTaskRuntimeConfig({ driver: "cloudflare", keepAlive: true })
    setSandboxTaskRuntimeRegistry({ example: definition })
    runtimeMocks.executeSandboxTaskDefinition.mockResolvedValue({ ok: true })

    const result = await runSandboxTaskRuntime("example")

    expect(result[0]).toBeUndefined()
    expect(result[1]).toEqual({ ok: true })
    expect(runtimeMocks.close).toHaveBeenCalledOnce()
  })

  it("declares the project package manager as a Sandbox requirement", async () => {
    setSandboxTaskRuntimeConfig({ driver: "vercel" })
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
    setSandboxTaskRuntimeConfig({ driver: "vercel" })
    setSandboxTaskRuntimeRegistry({ example: packageDefinition })
    runtimeMocks.executeSandboxTaskDefinition.mockResolvedValue({ ok: true })

    const result = await runSandboxTaskRuntime("example")

    expect(result[0]).toBeUndefined()
    expect(result[1]).toEqual({ ok: true })
    expect(runtimeMocks.executeSandboxTaskDefinition).toHaveBeenCalledWith(
      expect.anything(),
      "example",
      { timeout: 300_000 },
      packageDefinition.bundle,
      undefined,
      undefined,
      expect.objectContaining({ onCommandStart: expect.any(Function) }),
    )
  })
})
