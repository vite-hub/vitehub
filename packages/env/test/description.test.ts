import { describe, expect, it } from "vitest"
import { env } from "../src/core/declarations.ts"
import { createRuntimeRegistry } from "../src/core/resolve.ts"
import { describeServerEnv } from "../src/server.ts"

describe("Server Env declaration inventory", () => {
  it("describes host, provider and literal declarations without exposing their values or storage keys", () => {
    const registry = createRuntimeRegistry({
      host: env({ secret: true, source: env.source("PRIVATE_HOST_NAME"), default: "private-default" }),
      nested: { token: env({ secret: true, source: env.provider("vault", "private/storage/path") }) },
      label: "private-literal",
      optional: env({ optional: true }),
    })
    const description = describeServerEnv(registry)
    expect(description.entries).toEqual([
      { path: "env.server.host", source: "env", secret: true, required: true, hasDefault: true },
      { path: "env.server.nested.token", source: "provider", provider: "vault", secret: true, required: true, hasDefault: false },
      { path: "env.server.label", source: "literal", secret: false, required: false, hasDefault: false },
      { path: "env.server.optional", source: "env", secret: false, required: false, hasDefault: false },
    ])
    const serialized = JSON.stringify(description)
    for (const value of ["PRIVATE_HOST_NAME", "private-default", "private/storage/path", "private-literal"]) expect(serialized).not.toContain(value)
  })

  it("returns independent metadata and withholds unsafe declaration names ", () => {
    const registry = createRuntimeRegistry({ "secret in name!": env({ source: env.provider("vault", "key") }) })
    expect(describeServerEnv(registry).entries).toEqual([{ source: "provider", provider: "vault", secret: false, required: true, hasDefault: false }])
    expect(describeServerEnv({})).toEqual({ entries: [] })
  })
})
