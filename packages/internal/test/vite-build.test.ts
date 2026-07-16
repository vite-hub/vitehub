import { describe, expect, it } from "vitest"

import { resolveNitroVercelFunctionName } from "../src/build/vite.ts"

describe("Vite provider builds", () => {
  it("isolates provider functions when Nitro owns the server output", () => {
    const plugins = [{ name: "vitehub" }, { name: "nitro:main" }]

    expect(resolveNitroVercelFunctionName(plugins, "blob")).toBe("__blob.func")
    expect(resolveNitroVercelFunctionName(plugins, "database")).toBe("__database.func")
    expect(resolveNitroVercelFunctionName(plugins, "queue")).toBe("__queue.func")
    expect(resolveNitroVercelFunctionName(plugins, "workflow")).toBe("__workflow.func")
    expect(resolveNitroVercelFunctionName([{ name: "vitehub" }], "blob")).toBeUndefined()
    expect(resolveNitroVercelFunctionName(undefined, "blob")).toBeUndefined()
  })
})
