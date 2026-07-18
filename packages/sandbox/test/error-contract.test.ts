import { describe, expect, it, vi } from "vitest"

import { toSandboxError } from "../src/runtime/error-normalization.ts"
import { readExecOutputWithRecovery } from "../src/runtime/output-recovery.ts"
import { CloudflareSandboxAdapter } from "../src/sandbox/adapters/cloudflare.ts"
import { CloudflareProcessHandle } from "../src/sandbox/adapters/cloudflare/process.ts"
import { VercelSandboxAdapter } from "../src/sandbox/adapters/vercel.ts"
import { collectDetachedCommandOutput } from "../src/sandbox/adapters/vercel/process.ts"
import { readSandboxErrorInternals, SandboxError } from "../src/sandbox/errors.ts"
import type { CloudflareSandboxStub } from "../src/sandbox/types/common.ts"
import type { VercelSandboxInstance } from "../src/sandbox/types/vercel.ts"

async function captureSandboxError(promise: Promise<unknown>): Promise<SandboxError> {
  try {
    await promise
  }
  catch (error) {
    if (!(error instanceof Error))
      throw error
    return error as SandboxError
  }

  throw new Error("Expected a SandboxError rejection")
}

describe("SandboxError public contract", () => {
  it("serializes only fixed messages and allowlisted details", () => {
    const secret = "token=vh_secret_123"
    const providerError = Object.assign(new Error(`provider failed: ${secret}`), {
      code: "SANDBOX_TRANSPORT_ERROR",
      details: {
        args: [secret],
        body: secret,
        command: secret,
        cwd: secret,
        operation: "readFile",
        responseBody: secret,
        status: 502,
        stderrPreview: secret,
        stdoutPreview: secret,
        timeout: 1_250,
        url: `https://example.test/?${secret}`,
      },
      provider: "cloudflare",
    })

    const error = toSandboxError(providerError)

    expect(error).toMatchObject({
      code: "SANDBOX_TRANSPORT_ERROR",
      details: { operation: "readFile", provider: "cloudflare", status: 502, timeoutMs: 1_250 },
      message: "Sandbox provider request failed.",
    })
    expect(error.cause).toBe(providerError)
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: "SANDBOX_TRANSPORT_ERROR",
      details: { operation: "readFile", provider: "cloudflare", status: 502, timeoutMs: 1_250 },
      message: "Sandbox provider request failed.",
    })
  })

  it.each([
    ["args", ["secret-args"]],
    ["body", "secret-body"],
    ["command", "secret-command"],
    ["cwd", "secret-cwd"],
    ["outputPreview", "secret-output"],
    ["responseBody", "secret-response"],
    ["stderrPreview", "secret-stderr"],
    ["stdoutPreview", "secret-stdout"],
    ["url", "https://secret.example.test/private"],
  ])("omits hostile %s diagnostics", (key, value) => {
    const error = new SandboxError({
      code: "SANDBOX_HANDLER_ERROR",
      details: { [key]: value },
      message: String(value),
    })
    expect(JSON.stringify(error)).not.toContain(String(Array.isArray(value) ? value[0] : value))
    expect(error.details).toBeUndefined()
  })

  it("maps provider-specific and unknown codes to ViteHub-owned codes", () => {
    expect(toSandboxError(Object.assign(new Error("secret"), { code: "VERCEL_SANDBOX_EXEC_FAILED" }))).toMatchObject({
      code: "SANDBOX_EXEC_FAILED",
      message: "Sandbox provider execution failed.",
    })
    expect(toSandboxError(Object.assign(new Error("secret"), { code: "SDK_TOKEN_EXPIRED" }))).toMatchObject({
      code: "SANDBOX_RUNTIME_ERROR",
      message: "Sandbox execution failed.",
    })
    expect(new SandboxError({ code: "CUSTOM_ERROR" as never, message: "secret" })).toMatchObject({
      code: "SANDBOX_RUNTIME_ERROR",
      message: "Sandbox execution failed.",
    })
  })

  it("preserves an abort reason by identity without serializing it", () => {
    const reason = new Error("abort-token=vh_secret_456")
    const controller = new AbortController()
    controller.abort(reason)
    const error = toSandboxError(controller.signal.reason)

    expect(error.cause).toBe(reason)
    expect(JSON.stringify(error)).not.toContain(reason.message)
    expect(JSON.stringify(error)).not.toContain("cause")
  })

  it("keeps direct client paths and stderr private", async () => {
    const secret = "/workspace/token=vh_secret_789"
    const adapter = new CloudflareSandboxAdapter("sandbox-id", {
      destroy: vi.fn(),
      exec: vi.fn(async () => ({ exitCode: 1, stderr: secret, stdout: "", success: false })),
      readFile: vi.fn(),
      writeFile: vi.fn(),
    } as unknown as CloudflareSandboxStub)

    const error = await captureSandboxError(adapter.mkdir(secret))
    expect(error).toMatchObject({ code: "SANDBOX_EXEC_FAILED", message: "Sandbox provider execution failed." })
    expect(readSandboxErrorInternals(error).message).toContain(secret)
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it("normalizes exported Cloudflare namespace failures", async () => {
    const secret = "cloudflare-native-token=vh_secret_321"
    const adapter = new CloudflareSandboxAdapter("sandbox-id", {
      destroy: vi.fn(),
      exec: vi.fn(),
      gitCheckout: vi.fn(async () => {
        throw new Error(secret)
      }),
      readFile: vi.fn(),
      writeFile: vi.fn(),
    } as unknown as CloudflareSandboxStub)

    const error = await captureSandboxError(adapter.cloudflare.gitCheckout("https://example.test/private"))
    expect(error).toMatchObject({
      code: "SANDBOX_TRANSPORT_ERROR",
      details: { operation: "gitCheckout", provider: "cloudflare" },
      message: "Sandbox provider request failed.",
    })
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it("normalizes nested Vercel filesystem failures", async () => {
    const secret = "vercel-native-token=vh_secret_852"
    const adapter = new VercelSandboxAdapter("sandbox-id", {
      fs: {
        writeFile: vi.fn(async () => {
          throw new Error(secret)
        }),
      },
    } as unknown as VercelSandboxInstance, { createdAt: "now", runtime: "node24" })

    const error = await captureSandboxError(adapter.writeFile("/private", "content"))
    expect(error).toMatchObject({
      code: "SANDBOX_TRANSPORT_ERROR",
      details: { operation: "writeFile", provider: "vercel" },
      message: "Sandbox provider request failed.",
    })
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it("preserves exact signal reasons and AbortErrors across native calls", async () => {
    const reason = new Error("cancelled with private reason")
    const controller = new AbortController()
    controller.abort(reason)
    const abortError = new DOMException("private abort", "AbortError")
    const readFile = vi.fn(async (_path: string, options?: { signal?: AbortSignal }) => {
      throw options?.signal?.reason
    })
    const writeFile = vi.fn(async () => {
      throw abortError
    })
    const adapter = new VercelSandboxAdapter("sandbox-id", {
      fs: { readFile, writeFile },
    } as unknown as VercelSandboxInstance, { createdAt: "now", runtime: "node24" })

    await expect(adapter.native.fs!.readFile("/private", { signal: controller.signal })).rejects.toBe(reason)
    await expect(adapter.writeFile("/private", "content")).rejects.toBe(abortError)
  })

  it("preserves cross-realm AbortError-shaped rejections", async () => {
    const abortError = { message: "private cross-realm abort", name: "AbortError" }
    const adapter = new VercelSandboxAdapter("sandbox-id", {
      fs: {
        writeFile: vi.fn(async () => {
          throw abortError
        }),
      },
    } as unknown as VercelSandboxInstance, { createdAt: "now", runtime: "node24" })

    await expect(adapter.writeFile("/private", "content")).rejects.toBe(abortError)
  })

  it("does not turn provider failures or cancellation into missing files", async () => {
    const missing = Object.assign(new Error("no such file"), { code: "ENOENT" })
    const transport = new Error("private transport failure")
    const abortError = new DOMException("private abort", "AbortError")
    const access = vi.fn()
      .mockRejectedValueOnce(missing)
      .mockRejectedValueOnce(transport)
      .mockRejectedValueOnce(abortError)
    const vercel = new VercelSandboxAdapter("sandbox-id", {
      fs: { access },
    } as unknown as VercelSandboxInstance, { createdAt: "now", runtime: "node24" })

    await expect(vercel.exists("/missing")).resolves.toBe(false)
    await expect(vercel.exists("/transport")).rejects.toMatchObject({
      code: "SANDBOX_TRANSPORT_ERROR",
      message: "Sandbox provider request failed.",
    })
    await expect(vercel.exists("/aborted")).rejects.toBe(abortError)

    const cloudflare = new CloudflareSandboxAdapter("sandbox-id", {
      destroy: vi.fn(),
      exec: vi.fn(async () => {
        throw transport
      }),
      readFile: vi.fn(),
      writeFile: vi.fn(),
    } as unknown as CloudflareSandboxStub)
    await expect(cloudflare.exists("/transport")).rejects.toMatchObject({
      code: "SANDBOX_TRANSPORT_ERROR",
      message: "Sandbox provider request failed.",
    })
  })

  it("preserves cancellation during output recovery and detached log collection", async () => {
    const abortError = new DOMException("private abort", "AbortError")
    const sandbox = {
      provider: "cloudflare",
      readFile: vi.fn(async () => {
        throw abortError
      }),
    }
    await expect(readExecOutputWithRecovery(sandbox as never, "/output", new Error("exec failed"))).rejects.toBe(abortError)
    await expect(readExecOutputWithRecovery({ provider: "cloudflare", readFile: vi.fn() } as never, "/output", abortError)).rejects.toBe(abortError)

    const command = {
      async *logs() {
        yield { data: "partial", stream: "stdout" as const }
        throw abortError
      },
      stderr: vi.fn(async () => ""),
      stdout: vi.fn(async () => "partial"),
      wait: vi.fn(async () => ({ exitCode: 0 })),
    }
    await expect(collectDetachedCommandOutput(command as never)).rejects.toBe(abortError)
  })

  it("uses private Cloudflare process diagnostics for log fallback", async () => {
    const processError = new SandboxError({
      code: "SANDBOX_TRANSPORT_ERROR",
      message: "ProcessExitedBeforeReadyError: exited with code 1",
    })
    const handle = new CloudflareProcessHandle("process-id", "node server.js", {
      getLogs: vi.fn(async () => ({ stderr: "", stdout: "server ready\n" })),
      kill: vi.fn(),
      waitForExit: vi.fn(),
      waitForLog: vi.fn(async () => {
        throw processError
      }),
      waitForPort: vi.fn(),
    })

    await expect(handle.waitForLog("server ready", 100)).resolves.toEqual({ line: "server ready" })
  })

  it("keeps Cloudflare SDK-load failures private", async () => {
    const secret = "cloudflare-sdk-token=vh_secret_987"
    vi.resetModules()
    vi.doMock("@cloudflare/sandbox", () => {
      throw new Error(secret)
    })

    try {
      const { createCloudflareSandboxClient } = await import("../src/sandbox/providers/cloudflare.ts")
      const error = await captureSandboxError(createCloudflareSandboxClient({ namespace: {} as never, provider: "cloudflare" }))
      expect(error).toMatchObject({
        code: "SANDBOX_RUNTIME_ERROR",
        details: { provider: "cloudflare" },
        message: "Sandbox execution failed.",
      })
      expect(error.cause).toMatchObject({ cause: { message: secret } })
      expect(JSON.stringify(error)).not.toContain(secret)
    }
    finally {
      vi.doUnmock("@cloudflare/sandbox")
      vi.resetModules()
    }
  })

  it("keeps Vercel SDK-load failures private", async () => {
    const secret = "vercel-sdk-token=vh_secret_654"
    vi.resetModules()
    vi.doMock("@vercel/sandbox", () => {
      throw new Error(secret)
    })

    try {
      const { createVercelSandboxClient } = await import("../src/sandbox/providers/vercel.ts")
      const error = await captureSandboxError(createVercelSandboxClient({ provider: "vercel" }))
      expect(error).toMatchObject({
        code: "SANDBOX_RUNTIME_ERROR",
        details: { provider: "vercel" },
        message: "Sandbox execution failed.",
      })
      expect(error.cause).toMatchObject({ cause: { message: secret } })
      expect(JSON.stringify(error)).not.toContain(secret)
    }
    finally {
      vi.doUnmock("@vercel/sandbox")
      vi.resetModules()
    }
  })
})
