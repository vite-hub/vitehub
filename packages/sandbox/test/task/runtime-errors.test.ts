import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Diagnostic } from "nostics"
import { unknownExecutionAuthority } from "@vite-hub/runtime"
import type { SandboxExecOptions, SandboxSession } from "@vite-hub/sandbox"

const providerMocks = vi.hoisted(() => ({ open: vi.fn() }))

vi.mock("vitehub-sandbox-task-provider-loader", () => ({
  loadSandboxTaskRuntimeProvider: async () => ({
    resolveTaskSandbox: async ({ provider }: { provider: { provider: "cloudflare" | "vercel", keepAlive?: boolean } }) => ({
      provider: provider.provider,
      closeAfterRun: provider.provider === "vercel" || provider.keepAlive === true,
      sandboxId: "shared-errors",
      resolveSandbox: async () => ({
        plan: { executionAuthority: unknownExecutionAuthority },
        open: providerMocks.open,
      }),
    }),
  }),
}))

import { resolveSandboxTaskRunner, runSandboxTaskRuntime } from "../../src/task/runtime/runtime.ts"
import { toSandboxTaskError } from "../../src/task/runtime/error-normalization.ts"
import { resetSandboxTaskRuntimeState, setSandboxTaskRuntimeConfig, setSandboxTaskRuntimeRegistry } from "../../src/task/runtime/state.ts"

// Only the provider is fake. The runtime stages, reads, decodes, and removes
// invocation files through this in-memory session. No remote command runs.
function createSession() {
  const files = new Map<string, Uint8Array>()
  const cleanup = vi.fn(async () => ({ ok: true, code: 0, stdout: "", stderr: "" }))
  const execute = vi.fn(async (_signal?: AbortSignal): Promise<unknown> => ({ ok: true, result: { answer: 42 } }))
  const session = {
    id: "shared-errors",
    cwd: "/workspace",
    executionAuthority: unknownExecutionAuthority,
    files: {
      exists: async (path: string) => files.has(path),
      list: async () => [],
      mkdir: async () => {},
      read: async (path: string) => files.get(path) ?? null,
      write: async (path: string, value: Uint8Array) => { files.set(path, value) },
      remove: async (path: string) => {
        for (const key of files.keys()) {
          if (key === path || key.startsWith(`${path}/`)) files.delete(key)
        }
      },
    },
    close: vi.fn(async () => {}),
    exec: vi.fn(async (command: string, args: readonly string[] = [], options?: SandboxExecOptions) => {
      if (command === "rm") {
        const result = await cleanup()
        if (result.ok && result.code === 0) await session.files.remove(args.at(-1)!)
        return result
      }
      expect(command).toBe("node")
      files.set(args.at(-1)!, new TextEncoder().encode(JSON.stringify(await execute(options?.signal))))
      return { ok: true, code: 0, stdout: "", stderr: "" }
    }),
  } satisfies SandboxSession
  providerMocks.open.mockResolvedValue(session)
  return { session, files, cleanup, execute }
}

function providerError() {
  return new Diagnostic({
    code: "TEST_PROVIDER_FAILURE",
    why: "Provider operation failed.",
    fix: "Restore filesystem access.",
    docs: "https://example.test/provider-failure",
    sources: ["private/provider.ts:12:3"],
    cause: new Error("private nested failure"),
  })
}

beforeEach(() => {
  providerMocks.open.mockReset()
  setSandboxTaskRuntimeConfig({ provider: "cloudflare", sandboxId: "shared-errors" })
  setSandboxTaskRuntimeRegistry({ example: {
    bundle: {
      entry: "index.mjs",
      modules: { "index.mjs": "export default async () => ({ answer: 42 })" },
    },
  } })
})

afterEach(() => {
  resetSandboxTaskRuntimeState()
  vi.useRealTimers()
})

describe("Sandbox Task error preservation", () => {
  it("keeps the startup diagnostic and its nested cause on the real runner", async () => {
    const original = providerError()
    providerMocks.open.mockRejectedValue(original)
    const runner = await resolveSandboxTaskRunner("example")
    const error = await runner.run().catch((error: unknown) => error)

    expect(error).toMatchObject({ code: "SANDBOX_TASK_RUNTIME_ERROR", cause: original })
    expect(toSandboxTaskError(error)).toBe(error)
    expect(toSandboxTaskError(error).cause).toBe(original)
    expect(original).toMatchObject({
      code: "TEST_PROVIDER_FAILURE",
      docs: "https://example.test/provider-failure",
      cause: { message: "private nested failure" },
    })
    expect(original.stack).toContain("providerError")

    const response = await runSandboxTaskRuntime("example")
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body).toEqual({ error: { code: "SANDBOX_TASK_RUNTIME_ERROR", message: original.message, details: {} } })
    expect(JSON.stringify(body)).not.toMatch(/private|TEST_PROVIDER_FAILURE|example\.test/)
  })

  it("keeps non-Error rejection objects as the cause", () => {
    const original = { cause: new Error("nested"), provider: "cloudflare" }
    expect(toSandboxTaskError(original).cause).toBe(original)
  })

  it("retries startup when the transient message is in the original cause", async () => {
    vi.useFakeTimers()
    const { execute } = createSession()
    providerMocks.open.mockRejectedValueOnce(new Error("Startup failed.", { cause: new Error("container is starting") }))

    const result = runSandboxTaskRuntime("example")
    await vi.advanceTimersByTimeAsync(1001)
    const response = await result

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ answer: 42 })
    expect(providerMocks.open).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledOnce()
  })

  it("retries staging when its transient cause survives a cleanup failure", async () => {
    vi.useFakeTimers()
    const { session, execute, cleanup } = createSession()
    session.files.write = vi.fn(session.files.write).mockRejectedValueOnce(new Error("Staging failed.", { cause: new Error("container is starting") }))
    cleanup.mockRejectedValueOnce(new Error("private cleanup failure"))

    const result = runSandboxTaskRuntime("example")
    await vi.advanceTimersByTimeAsync(1001)
    const response = await result

    expect(response.status).toBe(200)
    expect(providerMocks.open).toHaveBeenCalledTimes(2)
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledOnce()
  })

  it("does not retry a permanent staging failure because cleanup looks transient", async () => {
    vi.useFakeTimers()
    const { session, execute, cleanup } = createSession()
    session.files.write = vi.fn(session.files.write).mockRejectedValue(new Error("Staging failed."))
    cleanup.mockRejectedValue(new Error("container is starting"))

    const result = runSandboxTaskRuntime("example")
    await vi.runAllTimersAsync()
    const response = await result

    expect(response.status).toBe(500)
    expect(providerMocks.open).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
  })

  it("returns the handler result after removing invocation files", async () => {
    const { files, session, cleanup } = createSession()
    const response = await runSandboxTaskRuntime("example", { input: "private input" })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ answer: 42 })
    expect(files.size).toBe(0)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(session.close).not.toHaveBeenCalled()
  })

  it.each(["rejection", "nonzero"])("reports a cleanup %s after a successful handler", async (failure) => {
    const { files, session, cleanup, execute } = createSession()
    if (failure === "rejection") cleanup.mockRejectedValue(new Error("private cleanup message", { cause: providerError() }))
    else cleanup.mockResolvedValue({ ok: false, code: 1, stdout: "private stdout", stderr: "private stderr" })

    const response = await runSandboxTaskRuntime("example", { input: "private input" })

    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body).toMatchObject({ error: { code: "SANDBOX_TASK_RUNTIME_ERROR" } })
    expect(JSON.stringify(body)).not.toMatch(/private|TEST_PROVIDER_FAILURE|example\.test/)
    expect(files.size).toBe(4)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledOnce()
    expect(session.close).not.toHaveBeenCalled()
  })

  it("retains a rejected cleanup diagnostic on the runner", async () => {
    const { cleanup } = createSession()
    const original = providerError()
    cleanup.mockRejectedValue(original)
    const runner = await resolveSandboxTaskRunner("example")

    await expect(runner.run()).rejects.toMatchObject({ code: "SANDBOX_TASK_RUNTIME_ERROR", cause: original })
  })

  it("retains a failed cleanup command result without exposing its output", async () => {
    const { cleanup } = createSession()
    const result = { ok: false, code: 1, stdout: "private stdout", stderr: "private stderr" }
    cleanup.mockResolvedValue(result)
    const runner = await resolveSandboxTaskRunner("example")
    const error = toSandboxTaskError(await runner.run().catch((error: unknown) => error))

    expect(error.cause).toBe(result)
    expect(error.details).toEqual({ provider: "cloudflare", operation: "cleanup", exitCode: 1 })
  })

  it("preserves the execution failure when cleanup succeeds", async () => {
    const { files, cleanup, execute } = createSession()
    const original = providerError()
    execute.mockRejectedValue(original)
    const runner = await resolveSandboxTaskRunner("example")
    const error = toSandboxTaskError(await runner.run().catch((error: unknown) => error))

    expect(error.cause).toBe(original)
    expect(files.size).toBe(0)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it("retains both execution and cleanup failures on the runner", async () => {
    const { cleanup, execute } = createSession()
    const executionError = providerError()
    const cleanupError = new Error("Cleanup failed.", { cause: new Error("private cleanup cause") })
    execute.mockRejectedValue(executionError)
    cleanup.mockRejectedValue(cleanupError)
    const runner = await resolveSandboxTaskRunner("example")
    const error = toSandboxTaskError(await runner.run().catch((error: unknown) => error))

    expect(error.cause).toBeInstanceOf(AggregateError)
    expect((error.cause as AggregateError).errors[0]).toBe(executionError)
    expect((error.cause as AggregateError).errors[1].cause).toBe(cleanupError)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledOnce()
  })

  it("keeps the handler error code when invocation cleanup also fails", async () => {
    const { cleanup, execute } = createSession()
    execute.mockResolvedValue({ ok: false, error: { message: "Handler failed." } })
    cleanup.mockRejectedValue(new Error("private cleanup message", { cause: providerError() }))

    const response = await runSandboxTaskRuntime("example")

    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body).toMatchObject({ error: {
      code: "SANDBOX_TASK_HANDLER_ERROR",
      message: "Handler failed.",
      details: { provider: "cloudflare" },
    } })
    expect(JSON.stringify(body)).not.toMatch(/private|TEST_PROVIDER_FAILURE|example\.test/)
    expect(execute).toHaveBeenCalledOnce()
  })

  it.each(["cloudflare", "vercel"] as const)("keeps the handler error when %s session close also fails", async (provider) => {
    const { session, execute } = createSession()
    setSandboxTaskRuntimeConfig(provider === "cloudflare"
      ? { provider, sandboxId: "shared-errors", keepAlive: true }
      : { provider })
    execute.mockResolvedValue({ ok: false, error: { message: "Handler failed." } })
    const cleanupError = new Error("private session cleanup message", { cause: providerError() })
    session.close.mockRejectedValue(cleanupError)
    const runner = await resolveSandboxTaskRunner("example")
    const error = toSandboxTaskError(await runner.run().catch((error: unknown) => error))

    expect(error).toMatchObject({ code: "SANDBOX_TASK_HANDLER_ERROR", message: "Handler failed." })
    expect(error.cause).toBeInstanceOf(AggregateError)
    expect((error.cause as AggregateError).errors[0]).toMatchObject({ code: "SANDBOX_TASK_HANDLER_ERROR" })
    expect((error.cause as AggregateError).errors[1]).toBe(cleanupError)

    const response = await runSandboxTaskRuntime("example")
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body).toMatchObject({ error: { code: "SANDBOX_TASK_HANDLER_ERROR", message: "Handler failed." } })
    expect(JSON.stringify(body)).not.toMatch(/private|TEST_PROVIDER_FAILURE|example\.test/)
  })

  it.each([undefined, null, false, 0])("preserves a falsy execution rejection %s when cleanup fails", async (failure) => {
    const { cleanup, execute } = createSession()
    execute.mockRejectedValue(failure)
    const cleanupError = providerError()
    cleanup.mockRejectedValue(cleanupError)
    const runner = await resolveSandboxTaskRunner("example")
    const error = toSandboxTaskError(await runner.run().catch((error: unknown) => error))

    expect(error.cause).toBeInstanceOf(AggregateError)
    expect((error.cause as AggregateError).errors[0]).toBe(failure)
    expect((error.cause as AggregateError).errors[1].cause).toBe(cleanupError)
  })

  it.each([
    { boundary: "runner", failure: "invocation rejection" },
    { boundary: "response", failure: "invocation rejection" },
    { boundary: "runner", failure: "invocation exit" },
    { boundary: "response", failure: "invocation exit" },
    { boundary: "runner", failure: "session rejection" },
    { boundary: "response", failure: "session rejection" },
  ])("preserves timeout and $failure through the $boundary", async ({ boundary, failure }) => {
    vi.useFakeTimers()
    const { session, cleanup, execute } = createSession()
    setSandboxTaskRuntimeRegistry({ example: {
      options: { timeout: 1000 },
      bundle: { entry: "index.mjs", modules: { "index.mjs": "export default async () => true" } },
    } })
    execute.mockImplementation(async signal => await new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })
    }))
    const cleanupError = providerError()
    const cleanupResult = { ok: false, code: 1, stdout: "private stdout", stderr: "private stderr" }
    if (failure === "session rejection") session.close.mockRejectedValue(cleanupError)
    else if (failure === "invocation exit") cleanup.mockResolvedValue(cleanupResult)
    else cleanup.mockRejectedValue(cleanupError)
    const runner = await resolveSandboxTaskRunner("example")
    const result = boundary === "runner"
      ? runner.run().catch((error: unknown) => error)
      : runSandboxTaskRuntime("example")
    await vi.advanceTimersByTimeAsync(1001)

    if (boundary === "runner") {
      const error = toSandboxTaskError(await result)
      expect(error.code).toBe("SANDBOX_TASK_TIMEOUT")
      const combined = failure === "session rejection" ? error : toSandboxTaskError(error.cause)
      expect(combined.cause).toBeInstanceOf(AggregateError)
      expect((combined.cause as AggregateError).errors[0]).toMatchObject({ code: "SANDBOX_TASK_TIMEOUT" })
      if (failure === "session rejection") expect((combined.cause as AggregateError).errors[1]).toBe(cleanupError)
      else expect((combined.cause as AggregateError).errors[1].cause).toBe(failure === "invocation exit" ? cleanupResult : cleanupError)
    }
    else {
      const response = await result as Response
      expect(response.status).toBe(504)
      expect(await response.json()).toMatchObject({ error: { code: "SANDBOX_TASK_TIMEOUT" } })
    }
    expect(session.exec.mock.calls.find(([command]) => command === "rm")?.[2]).toEqual({ timeout: 1000 })
    expect(session.close).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledOnce()
  })
})
