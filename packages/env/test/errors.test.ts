import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { env, EnvError, resolveServerEnv } from "../src/index.ts"
import { createSourceContext, resolveEnvEntries, validateEnvConfigShape } from "../src/core/resolve.ts"
import { parseSchema } from "../src/schema.ts"

describe("EnvError", () => {
  it("keeps structured details public and the cause in memory", () => {
    const cause = new Error("secret provider failure")
    const error = new EnvError({
      cause,
      code: "ENV_SOURCE_FAILED",
      details: { source: "vault:token" },
      message: "Env source failed.",
    })

    expect(error).toBeInstanceOf(ViteHubError)
    expect(error.cause).toBe(cause)
    expect(error.toJSON()).toEqual({
      code: "ENV_SOURCE_FAILED",
      details: { source: "vault:token" },
      message: "Env source failed.",
    })
    expect(JSON.stringify(error)).not.toContain("secret provider failure")
  })

  it("classifies invalid declarations and missing runtime values", () => {
    expect(() => validateEnvConfigShape({ unknown: env() } as never, "vite")).toThrow(expect.objectContaining({
      code: "ENV_DECLARATION_INVALID",
      details: { path: "env.unknown" },
    }))

    expect(() => resolveServerEnv({
      token: {
        required: true,
        secret: true,
        source: { kind: "env", label: "env:TOKEN", name: "TOKEN", names: ["TOKEN"], serializable: true },
      },
    }, { env: {} })).toThrow(expect.objectContaining({
      code: "ENV_REQUIRED_MISSING",
      details: { source: "env:TOKEN" },
    }))

    expect(() => resolveServerEnv({
      port: {
        default: 3000,
        required: false,
        secret: false,
        source: { kind: "env", label: "env:PORT", name: "PORT", names: ["PORT"], serializable: true },
      },
    }, { env: {} })).toThrow(expect.objectContaining({
      code: "ENV_RUNTIME_VALUE_INVALID",
      details: { source: "env:PORT" },
    }))

    expect(() => resolveServerEnv({
      token: {
        required: true,
        secret: true,
        source: { kind: "env", label: "env:TOKEN", name: "TOKEN", names: ["TOKEN"], serializable: true },
      },
    }, { env: { TOKEN: {} } })).toThrow(expect.objectContaining({
      code: "ENV_RUNTIME_VALUE_INVALID",
      details: { source: "env:TOKEN" },
    }))
  })

  it("keeps declaration misuse and schema helpers outside the Env error family", () => {
    expect.assertions(3)
    expect(() => env({ optional: true, required: true })).toThrow(TypeError)

    try {
      parseSchema({ safeParse: () => ({ error: "invalid", success: false }) }, "value", "env.value")
    }
    catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(EnvError)
    }
  })

  it("normalizes built-in Git and package metadata source failures", async () => {
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
      message: "Env source git:branch failed.",
    })
    expect(JSON.stringify(gitError)).not.toContain("git credential leaked")

    const packageCause = new Error("private package metadata leaked")
    context.packageJson = async () => {
      throw packageCause
    }

    const packageError = await resolveEnvEntries({
      name: env({ mode: "build", source: env.packageJson("name") }),
    }, input).then(() => undefined, error => error)

    expect(packageError).toMatchObject({
      cause: packageCause,
      code: "ENV_SOURCE_FAILED",
      details: { source: "package.json:name" },
      message: "Env source package.json:name failed.",
    })
    expect(JSON.stringify(packageError)).not.toContain("private package metadata leaked")
  })
})
