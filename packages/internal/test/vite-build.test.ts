import { describe, expect, it } from "vitest"

import { resolveNitroVercelFunctionName } from "../src/build/vite.ts"

describe("Vite provider builds", () => {
  it("isolates provider functions when Nitro owns the Vercel output", () => {
    const plugins = [{ name: "vitehub" }, { name: "nitro:main" }]

    expect(resolveNitroVercelFunctionName(plugins, "blob", "vercel", {})).toBe("__blob.func")
    expect(resolveNitroVercelFunctionName(plugins, "database", "vercel-edge", {})).toBe("__database.func")
    expect(resolveNitroVercelFunctionName(plugins, "queue", undefined, { VERCEL: "1" })).toBe("__queue.func")
    expect(resolveNitroVercelFunctionName(plugins, "workflow", undefined, { VITEHUB_HOSTING: "vercel" })).toBe("__workflow.func")
    expect(resolveNitroVercelFunctionName([{ name: "vitehub" }], "blob", "vercel", {})).toBeUndefined()
    expect(resolveNitroVercelFunctionName(undefined, "blob", "vercel", {})).toBeUndefined()
    expect(resolveNitroVercelFunctionName(plugins, "blob", "node-server", {})).toBeUndefined()
    expect(resolveNitroVercelFunctionName(plugins, "blob", "node-server", { VERCEL: "1" })).toBeUndefined()
    expect(resolveNitroVercelFunctionName(plugins, "blob", "cloudflare", { VITEHUB_HOSTING: "vercel" })).toBeUndefined()
  })
})
