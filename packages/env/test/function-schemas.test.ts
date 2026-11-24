import { describe, expect, it } from "vitest"

import { env } from "../src/core/declarations.ts"
import { createRuntimeRegistry, createSourceContext, resolveEnvEntries } from "../src/core/resolve.ts"
import { bindServerEnvSchemas, resolveServerEnv } from "../src/server.ts"
import { cloudflareRequest } from "./cloudflare-request.ts"

interface ArkLikeIssue {
  message: string
  path: readonly PropertyKey[]
}

class ArkLikeErrors extends Array<ArkLikeIssue> {
  get issues(): this {
    return this
  }
}

function arkLikeSecret(): (input: unknown) => unknown {
  const validate = (input: unknown) => typeof input === "string" && input.length >= 16
    ? { value: input }
    : ArkLikeErrors.of({ message: "must be at least length 16", path: [] })
  const prototype = Object.create(Function.prototype, {
    "~standard": { get: () => ({ validate, vendor: "arktype", version: 1 }) },
  })
  return Object.setPrototypeOf((input: unknown) => validate(input), prototype)
}

function capture(operation: () => unknown): unknown {
  try {
    operation()
  }
  catch (error) {
    return error
  }
  throw new Error("Expected operation to throw")
}

describe("function-shaped Standard Schemas", () => {
  it("rejects a bad public value and names the issue", async () => {
    const resolving = resolveEnvEntries({
      token: env({ mode: "build", schema: arkLikeSecret(), source: env.source("TOKEN") }),
    }, {
      context: createSourceContext({ env: { TOKEN: "short" }, mode: "build", rootDir: process.cwd() }),
      exposure: "build public",
      section: "env.public",
      timing: "test",
    })
    await expect(resolving).rejects.toThrow("Invalid env.public.token: must be at least length 16")
  })

  it("rejects a bad server value and names the issue", () => {
    const registry = createRuntimeRegistry({
      token: env({ schema: env.schemaFrom("./server/env.schema.ts", "token"), source: env.source("TOKEN") }),
    }, { schemaModules: true })
    bindServerEnvSchemas(registry, { "./server/env.schema.ts": { token: arkLikeSecret() } })

    const error = capture(() => resolveServerEnv(registry, cloudflareRequest({ TOKEN: "short" })))
    expect(error).toMatchObject({ code: "ENV_RUNTIME_VALUE_INVALID", details: { path: "env.server.token" } })
    expect(String((error as Error).cause)).toContain("must be at least length 16")
    expect(resolveServerEnv(registry, cloudflareRequest({ TOKEN: "a-long-enough-secret" }))).toMatchObject({ token: "a-long-enough-secret" })
  })
})
