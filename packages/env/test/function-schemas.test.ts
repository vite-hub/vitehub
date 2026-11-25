import { describe, expect, it } from "vitest"

import { env } from "../src/core/declarations.ts"
import { createRuntimeRegistry, createSourceContext, resolveEnvEntries } from "../src/core/resolve.ts"
import { parseSchema } from "../src/schema.ts"
import type { StandardSchemaV1 } from "../src/schema.ts"
import { bindServerEnvSchemas, resolveServerEnv } from "../src/server.ts"
import { cloudflareRequest } from "./cloudflare-request.ts"

interface ArkLikeIssue {
  message: string
  path: readonly PropertyKey[]
}

class ArkLikePath extends Array<PropertyKey> {
  constructor(...segments: PropertyKey[]) {
    super()
    this.push(...segments)
  }
}

class ArkLikeErrors extends Array<ArkLikeIssue> {
  get issues(): this {
    return this
  }
}

function arkLikeSecret(): (input: unknown) => unknown {
  const validate = (input: unknown) => typeof input === "string" && input.length >= 16
    ? { value: input }
    : ArkLikeErrors.of({ message: "must be at least length 16", path: new ArkLikePath() })
  const prototype = Object.create(Function.prototype, {
    "~standard": { get: () => ({ validate, vendor: "arktype", version: 1 }) },
  })
  return Object.setPrototypeOf((input: unknown) => validate(input), prototype)
}

function standardSchema(validate: (input: unknown) => unknown): object {
  return { "~standard": { validate, vendor: "test", version: 1 } }
}

function throwingStandard(): StandardSchemaV1 {
  return {
    get "~standard"(): StandardSchemaV1["~standard"] {
      throw new Error("schema setup failed")
    },
  }
}

function throwingValidate(): StandardSchemaV1 {
  return {
    "~standard": {
      get validate(): StandardSchemaV1["~standard"]["validate"] {
        throw new Error("schema setup failed")
      },
    },
  }
}

function resolvePublic(schema: unknown, value: string): Promise<unknown> {
  return resolveEnvEntries({
    token: env({ mode: "build", schema, source: env.source("TOKEN") }),
  }, {
    context: createSourceContext({ env: { TOKEN: value }, mode: "build", rootDir: process.cwd() }),
    exposure: "build public",
    section: "env.public",
    timing: "test",
  })
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

  it("does not add a path segment for an empty ArkType path", () => {
    expect(() => parseSchema(arkLikeSecret(), "short", "env.public.token")).toThrow(/^\[vitehub\] Invalid env\.public\.token: must be at least length 16$/)
  })

  it("keeps the path of a nested ArkType issue", () => {
    const schema = standardSchema(() => ArkLikeErrors.of({ message: "must be a number", path: new ArkLikePath("limits", 0) }))
    expect(() => parseSchema(schema, "x", "env.public.limits")).toThrow("Invalid env.public.limits: limits.0: must be a number")
  })

  it("keeps text issues", async () => {
    const schema = standardSchema(() => ({ issues: ["Select us-east-1 or eu-west-1."] }))
    await expect(resolvePublic(schema, "mars")).rejects.toThrow("Invalid env.public.token: Select us-east-1 or eu-west-1.")

    const registry = createRuntimeRegistry({
      region: env({ schema: env.schemaFrom("./server/env.schema.ts", "region"), source: env.source("REGION") }),
    }, { schemaModules: true })
    bindServerEnvSchemas(registry, { "./server/env.schema.ts": { region: schema } })
    const error = capture(() => resolveServerEnv(registry, cloudflareRequest({ REGION: "mars" })))
    expect(String((error as Error).cause)).toContain("Select us-east-1 or eu-west-1.")
  })

  it.each([
    ["~standard", throwingStandard],
    ["validate", throwingValidate],
  ])("stops when the schema's %s getter throws", async (_getter, schema) => {
    const resolving = resolvePublic(schema(), "not-a-url")
    await expect(resolving).rejects.toMatchObject({ code: "ENV_DECLARATION_INVALID", details: { path: "env.public.token" } })
    const error: unknown = await resolving.catch((cause: unknown) => cause)
    expect((error as Error).cause).toMatchObject({ cause: { message: "schema setup failed" } })

    const registry = createRuntimeRegistry({
      token: env({ schema: env.schemaFrom("./server/env.schema.ts", "token"), source: env.source("TOKEN") }),
    }, { schemaModules: true })
    expect(capture(() => bindServerEnvSchemas(registry, { "./server/env.schema.ts": { token: schema() } })))
      .toMatchObject({ code: "ENV_DECLARATION_INVALID", details: { path: "env.server.token" } })

    expect(capture(() => env.json(schema(), { mode: "build" }))).toMatchObject({ code: "ENV_DECLARATION_INVALID" })
  })

  it("rejects a bad server value and names the issue", () => {
    const registry = createRuntimeRegistry({
      token: env({ schema: env.schemaFrom("./server/env.schema.ts", "token"), source: env.source("TOKEN") }),
    }, { schemaModules: true })
    bindServerEnvSchemas(registry, { "./server/env.schema.ts": { token: arkLikeSecret() } })

    const error = capture(() => resolveServerEnv(registry, cloudflareRequest({ TOKEN: "short" })))
    expect(error).toMatchObject({ code: "ENV_RUNTIME_VALUE_INVALID", details: { path: "env.server.token" } })
    expect(String((error as Error).cause)).toBe("ENV_R0011: Invalid env.server.token from env. must be at least length 16")
    expect(resolveServerEnv(registry, cloudflareRequest({ TOKEN: "a-long-enough-secret" }))).toMatchObject({ token: "a-long-enough-secret" })
  })
})
