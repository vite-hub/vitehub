import { describe, expect, it } from "vitest"

import { env } from "../src/index.ts"
import { createSourceContext, resolveEnvEntries } from "../src/core/resolve.ts"

const passthrough = { safeParse: (data: unknown) => ({ data, success: true as const }) }

describe("package.json source paths", () => {
  it.each(["constructor", "toString", "__proto__", "constructor.prototype"])("does not read inherited package metadata at %s", async path => {
    const context = createSourceContext({ env: {}, mode: "build", rootDir: "/tmp" })
    context.packageJson = async () => JSON.parse('{"name":"app"}')

    const result = await resolveEnvEntries({
      value: env({ mode: "build", optional: true, schema: passthrough, source: env.packageJson(path) }),
    }, {
      context,
      exposure: "build public",
      section: "env.public",
      timing: "test",
    })

    expect(result.entries[0]).toMatchObject({ key: "value", source: `package.json:${path}`, value: undefined })
    expect(result.diagnostics[0]).toMatchObject({ key: "env.public.value", source: `package.json:${path}`, status: "missing" })
  })
})
