import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { env, resolveServerEnv } from "../src/index.ts"
import { envSourceFailed } from "../src/core/errors.ts"
import { createSourceContext, resolveEnvEntries, validateEnvConfigShape } from "../src/core/resolve.ts"
import { parseSchema } from "../src/schema.ts"

describe("Env errors", () => {
  it("publishes a closed code, message, and details contract", () => {
    const cause = new Error("secret provider failure")
    const error = envSourceFailed("custom", cause)

    expect(error).toBeInstanceOf(ViteHubError)
    expect(error.cause).toBe(cause)
    expect(error.toJSON()).toEqual({
      code: "ENV_SOURCE_FAILED",
      details: { source: "custom" },
      message: "[vitehub] Env source resolution failed.",
      name: "ViteHubError",
    })
    expect(JSON.stringify(error)).not.toContain("secret provider failure")
  })

  it("classifies invalid declarations and missing runtime values without exposing diagnostics", () => {
    const declarationError = capture(() => validateEnvConfigShape({ unknown: env() } as never, "vite"))
    expect(declarationError).toMatchObject({
      code: "ENV_DECLARATION_INVALID",
      details: { path: "env.unknown" },
      message: "[vitehub] Env declaration is invalid.",
    })
    expect(declarationError.cause).toBeInstanceOf(TypeError)

    const missingError = capture(() => resolveServerEnv({
      token: {
        required: true,
        secret: true,
        source: { kind: "env", label: "env:TOKEN", name: "TOKEN", names: ["TOKEN"], serializable: true },
      },
    }, { env: {} }))
    expect(missingError).toMatchObject({
      code: "ENV_REQUIRED_MISSING",
      details: { source: "env" },
      message: "[vitehub] Required Env value is missing.",
    })

    const invalidError = capture(() => resolveServerEnv({
      token: {
        required: true,
        secret: true,
        source: { kind: "env", label: "env:TOKEN", name: "TOKEN", names: ["TOKEN"], serializable: true },
      },
    }, { env: { TOKEN: {} } }))
    expect(invalidError).toMatchObject({
      code: "ENV_RUNTIME_VALUE_INVALID",
      details: { source: "env" },
      message: "[vitehub] Runtime Env value is invalid.",
    })
    expect(JSON.stringify([declarationError, missingError, invalidError])).not.toContain("TOKEN")

    expect(resolveServerEnv({
      token: {
        required: true,
        secret: false,
        source: { kind: "env", label: "env:TOKEN", name: "TOKEN", names: ["TOKEN", "TOKEN_FALLBACK"], serializable: true },
      },
    }, { env: { TOKEN: undefined, TOKEN_FALLBACK: "fallback" } })).toEqual({ token: "fallback" })
  })

  it("keeps declaration misuse and schema helpers outside the Env error family", () => {
    expect.assertions(3)
    expect(() => env({ optional: true, required: true })).toThrow(TypeError)

    try {
      parseSchema({ safeParse: () => ({ error: "invalid", success: false }) }, "value", "env.value")
    }
    catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(ViteHubError)
    }
  })

  it("normalizes built-in source failures without exposing source paths", async () => {
    const context = createSourceContext({ env: {}, mode: "build", rootDir: "/app" })
    const input = {
      context,
      exposure: "build public" as const,
      section: "env.public" as const,
      timing: "build",
    }
    const gitCause = new Error("git credential leaked")
    context.git.branch = async () => {
      throw gitCause
    }

    const gitError = await resolveEnvEntries({
      branch: env({ mode: "build", source: env.gitBranch() }),
    }, input).then(() => undefined, error => error)

    expect(gitError).toMatchObject({
      cause: gitCause,
      code: "ENV_SOURCE_FAILED",
      details: { source: "git:branch" },
      message: "[vitehub] Env source resolution failed.",
    })

    const packageCause = new Error("private package metadata leaked")
    context.packageJson = async () => {
      throw packageCause
    }
    const hostilePath = "https://user:token@example.com/private/package.json"
    const packageError = await resolveEnvEntries({
      name: env({ mode: "build", source: env.packageJson(hostilePath) }),
    }, input).then(() => undefined, error => error)

    expect(packageError).toMatchObject({
      cause: packageCause,
      code: "ENV_SOURCE_FAILED",
      details: { source: "package.json" },
      message: "[vitehub] Env source resolution failed.",
    })
    expect(JSON.stringify([gitError, packageError])).not.toMatch(/credential|token|example\.com/)
  })

  it("preserves cancellation, existing Env errors, and custom resolver errors exactly", async () => {
    const context = createSourceContext({ env: {}, mode: "build", rootDir: "/app" })
    const input = {
      context,
      exposure: "build public" as const,
      section: "env.public" as const,
      timing: "build",
    }
    const abort = Object.assign(new Error("cancelled"), { name: "AbortError" })
    context.git.branch = async () => {
      throw abort
    }
    await expect(resolveEnvEntries({
      branch: env({ mode: "build", source: env.gitBranch() }),
    }, input)).rejects.toBe(abort)

    const existing = new ViteHubError("ENV_SOURCE_FAILED", "Custom Env source failure.", { details: { source: "git:branch" } })
    context.git.branch = async () => {
      throw existing
    }
    await expect(resolveEnvEntries({
      branch: env({ mode: "build", source: env.gitBranch() }),
    }, input)).rejects.toBe(existing)

    const custom = new Error("application-owned custom resolver failure")
    await expect(resolveEnvEntries({
      custom: env({ mode: "build", source: env.custom("private:vault", () => Promise.reject(custom)) }),
    }, input)).rejects.toBe(custom)

    const missingCustom = await resolveEnvEntries({
      custom: env({ mode: "build", source: env.custom("git:branch", () => undefined) }),
    }, input).then(() => undefined, error => error)
    expect(missingCustom).toMatchObject({
      code: "ENV_REQUIRED_MISSING",
      details: { path: "env.public.custom", source: "custom" },
    })
  })

  it("omits hostile declaration paths from the public shape", () => {
    const hostileKey = "https://user:token@example.com"
    const error = capture(() => validateEnvConfigShape({
      public: { [hostileKey]: env() },
    }, "vite"))

    expect(error).toMatchObject({
      code: "ENV_DECLARATION_INVALID",
      message: "[vitehub] Env declaration is invalid.",
    })
    expect(error.details).toBeUndefined()
    expect(String((error.cause as Error).message)).toContain(hostileKey)
    expect(JSON.stringify(error)).not.toContain("example.com")
  })
})

function capture(run: () => unknown): ViteHubError {
  try {
    run()
  }
  catch (error) {
    return error as ViteHubError
  }
  throw new Error("Expected operation to throw.")
}
