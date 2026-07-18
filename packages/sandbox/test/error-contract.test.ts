import { describe, expect, it, vi } from "vitest"

import { toSandboxError } from "../src/runtime/error-normalization.ts"
import { CloudflareSandboxAdapter } from "../src/sandbox/adapters/cloudflare.ts"
import { readSandboxErrorInternals, SandboxError } from "../src/sandbox/errors.ts"
import type { CloudflareSandboxStub } from "../src/sandbox/types/common.ts"

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
      provider: "cloudflare",
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
    const error = new SandboxError(String(value), { code: "SANDBOX_HANDLER_ERROR", details: { [key]: value } })
    expect(JSON.stringify(error)).not.toContain(String(Array.isArray(value) ? value[0] : value))
    expect(error.details).toBeUndefined()
  })

  it("maps provider-specific and unknown codes to ViteHub-owned codes", () => {
    expect(new SandboxError("secret", { code: "VERCEL_SANDBOX_EXEC_FAILED", provider: "vercel" })).toMatchObject({
      code: "SANDBOX_EXEC_FAILED",
      message: "Sandbox provider execution failed.",
    })
    expect(new SandboxError("secret", { code: "SDK_TOKEN_EXPIRED" })).toMatchObject({
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

    const error = await adapter.mkdir(secret).catch(error => error as SandboxError)
    expect(error).toMatchObject({ code: "SANDBOX_RUNTIME_ERROR", message: "Sandbox execution failed." })
    expect(readSandboxErrorInternals(error).message).toContain(secret)
    expect(JSON.stringify(error)).not.toContain(secret)
  })
})
