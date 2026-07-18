import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it, vi } from "vitest"

import { toSandboxError } from "../src/runtime/error-normalization.ts"
import { readExecOutputWithRecovery } from "../src/runtime/output-recovery.ts"
import { CloudflareSandboxAdapter } from "../src/sandbox/adapters/cloudflare.ts"
import { CloudflareProcessHandle } from "../src/sandbox/adapters/cloudflare/process.ts"
import { VercelSandboxAdapter } from "../src/sandbox/adapters/vercel.ts"
import { collectDetachedCommandOutput } from "../src/sandbox/adapters/vercel/process.ts"
import { NotSupportedError, readSandboxErrorInternals, SandboxError } from "../src/sandbox/errors.ts"
import { createCloudflareSandboxClient } from "../src/sandbox/providers/cloudflare.ts"
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

function cloudflareAdapter(native: Record<string, unknown> = {}) {
  return new CloudflareSandboxAdapter("sandbox-id", {
    destroy: vi.fn(),
    exec: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    ...native,
  } as unknown as CloudflareSandboxStub)
}

function vercelAdapter(native: Record<string, unknown>) {
  return new VercelSandboxAdapter(
    "sandbox-id",
    native as unknown as VercelSandboxInstance,
    { createdAt: "now", runtime: "node24" },
  )
}

describe("SandboxError public contract", () => {
  it("inherits the shared contract and owns unsupported operations", () => {
    const error = new NotSupportedError("snapshot", "vercel")

    expect(error).toBeInstanceOf(ViteHubError)
    expect(error).toBeInstanceOf(SandboxError)
    expect(error.toJSON()).toEqual({
      code: "SANDBOX_NOT_SUPPORTED",
      details: { operation: "snapshot", provider: "vercel" },
      message: "Sandbox operation is not supported by the selected provider.",
    })
  })

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
    const adapter = cloudflareAdapter({
      exec: vi.fn(async () => ({ exitCode: 1, stderr: secret, stdout: "", success: false })),
    })

    const error = await captureSandboxError(adapter.mkdir(secret))
    expect(error).toMatchObject({ code: "SANDBOX_EXEC_FAILED", message: "Sandbox provider execution failed." })
    expect(readSandboxErrorInternals(error).message).toContain(secret)
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it.each([
    {
      invoke: (secret: string) => cloudflareAdapter({
        gitCheckout: vi.fn(async () => { throw new Error(secret) }),
      }).cloudflare.gitCheckout("https://example.test/private"),
      operation: "gitCheckout",
      provider: "cloudflare",
    },
    {
      invoke: (secret: string) => vercelAdapter({
        fs: { writeFile: vi.fn(async () => { throw new Error(secret) }) },
      }).writeFile("/private", "content"),
      operation: "writeFile",
      provider: "vercel",
    },
  ] as const)("normalizes $provider native failures", async ({ invoke, operation, provider }) => {
    const secret = `${provider}-native-token=vh_secret`
    const error = await captureSandboxError(invoke(secret))
    expect(error).toMatchObject({
      code: "SANDBOX_TRANSPORT_ERROR",
      details: { operation, provider },
      message: "Sandbox provider request failed.",
    })
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it("preserves safe diagnostics through recursively wrapped native calls", async () => {
    const secret = "nested-native-token=vh_secret"
    const cause = Object.assign(new Error(secret), {
      cause: { response: { status: 429 }, timeout: 2_500 },
    })
    const process = {
      id: "process-id",
      marker: "receiver-ok",
      async kill() {},
      async logs() {
        return { stderr: "", stdout: this.marker }
      },
      async wait() {
        return { exitCode: 0 }
      },
    }
    const session = {
      id: "session-id",
      marker: "receiver-ok",
      async destroy() {},
      async exec(command: string) {
        if (command === "fail")
          throw cause
        return { exitCode: 0, stderr: "", stdout: `${this.marker}:${command}` }
      },
      async startProcess() {
        if (this.marker !== "receiver-ok")
          throw new Error("invalid session receiver")
        return process
      },
    }
    const adapter = cloudflareAdapter({
      async createSession() {
        return session
      },
    })

    const nativeSession = await adapter.cloudflare.createSession()
    await expect(nativeSession.exec("pwd")).resolves.toMatchObject({ stdout: "receiver-ok:pwd" })
    await expect((await nativeSession.startProcess("node")).logs()).resolves.toEqual({
      stderr: "",
      stdout: "receiver-ok",
    })

    const error = await captureSandboxError(nativeSession.exec("fail"))
    expect(error).toMatchObject({
      cause,
      code: "SANDBOX_TRANSPORT_ERROR",
      details: { operation: "exec", provider: "cloudflare", status: 429, timeoutMs: 2_500 },
      message: "Sandbox provider request failed.",
    })
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(JSON.stringify(error)).not.toContain("cause")
  })

  it("normalizes direct Cloudflare creation rejections", async () => {
    const secret = "cloudflare-create-token=vh_secret"
    const cause = Object.assign(new Error(secret), {
      response: { status: 503 },
      timeoutMs: 1_500,
    })

    const error = await captureSandboxError(createCloudflareSandboxClient({
      getSandbox: () => { throw cause },
      namespace: {} as never,
      provider: "cloudflare",
    }))

    expect(error).toMatchObject({
      cause,
      code: "SANDBOX_RUNTIME_ERROR",
      details: { operation: "create", provider: "cloudflare", status: 503, timeoutMs: 1_500 },
      message: "Sandbox execution failed.",
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
    const adapter = vercelAdapter({
      fs: { readFile, writeFile },
    })

    await expect(adapter.native.fs!.readFile("/private", { signal: controller.signal })).rejects.toBe(reason)
    await expect(adapter.writeFile("/private", "content")).rejects.toBe(abortError)
  })

  it("preserves cross-realm AbortError-shaped rejections", async () => {
    const abortError = { message: "private cross-realm abort", name: "AbortError" }
    const adapter = vercelAdapter({
      fs: {
        writeFile: vi.fn(async () => {
          throw abortError
        }),
      },
    })

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
    const vercel = vercelAdapter({
      fs: { access },
    })

    await expect(vercel.exists("/missing")).resolves.toBe(false)
    await expect(vercel.exists("/transport")).rejects.toMatchObject({
      code: "SANDBOX_TRANSPORT_ERROR",
      message: "Sandbox provider request failed.",
    })
    await expect(vercel.exists("/aborted")).rejects.toBe(abortError)

    const cloudflare = cloudflareAdapter({
      exec: vi.fn(async () => {
        throw transport
      }),
    })
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

  it.each([
    {
      invoke: async () => (await import("../src/sandbox/providers/cloudflare.ts"))
        .createCloudflareSandboxClient({ namespace: {} as never, provider: "cloudflare" }),
      module: "@cloudflare/sandbox",
      provider: "cloudflare",
    },
    {
      invoke: async () => (await import("../src/sandbox/providers/vercel.ts"))
        .createVercelSandboxClient({ provider: "vercel" }),
      module: "@vercel/sandbox",
      provider: "vercel",
    },
  ] as const)("keeps $provider SDK-load failures private", async ({ invoke, module, provider }) => {
    const secret = `${provider}-sdk-token=vh_secret`
    vi.resetModules()
    vi.doMock(module, () => {
      throw new Error(secret)
    })

    try {
      const error = await captureSandboxError(invoke())
      expect(error).toMatchObject({
        code: "SANDBOX_RUNTIME_ERROR",
        details: { provider },
        message: "Sandbox execution failed.",
      })
      expect(error.cause).toMatchObject({ cause: { message: secret } })
      expect(JSON.stringify(error)).not.toContain(secret)
    }
    finally {
      vi.doUnmock(module)
      vi.resetModules()
    }
  })
})
