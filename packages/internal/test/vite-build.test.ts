import { describe, expect, it } from "vitest"

import {
  hasNitroConfigContext,
  resolveNitroVercelFunctionName,
  VITEHUB_NITRO_CONFIG_CONTEXT,
} from "../src/build/vite.ts"

describe("Vite provider builds", () => {
  it("distinguishes the Nitro host plugin from ViteHub bridge plugins", () => {
    expect(hasNitroConfigContext({ plugins: [{ name: "nitro:main" }] })).toBe(true)
    expect(hasNitroConfigContext({ plugins: [[false, [{ name: "nitro:main" }]]] })).toBe(true)
    expect(hasNitroConfigContext({ [VITEHUB_NITRO_CONFIG_CONTEXT]: true })).toBe(true)
    expect(hasNitroConfigContext({ plugins: [{ name: "@vite-hub/blob/vite" }, { name: "@vite-hub/queue/vite" }] })).toBe(false)
    expect(hasNitroConfigContext({ plugins: [[{ name: "@vite-hub/blob/vite" }]] })).toBe(false)
  })

  it("isolates provider functions when Nitro owns the Vercel output", () => {
    const plugins = [{ name: "vitehub" }, { name: "nitro:main" }]

    expect(resolveNitroVercelFunctionName({ plugins, nitro: { preset: "vercel" } }, "blob", {})).toBe("__blob.func")
    expect(resolveNitroVercelFunctionName({ plugins, nitro: { preset: "vercel-edge" } }, "database", {})).toBe("__database.func")
    expect(resolveNitroVercelFunctionName({ plugins }, "queue", { VERCEL: "1" })).toBe("__queue.func")
    expect(resolveNitroVercelFunctionName({ plugins }, "workflow", { VITEHUB_HOSTING: "vercel" })).toBe("__workflow.func")
    expect(resolveNitroVercelFunctionName({ nitro: { preset: "vercel" }, plugins: [{ name: "vitehub" }] }, "blob", {})).toBe("__blob.func")
    expect(resolveNitroVercelFunctionName({ nitro: { preset: "vercel-edge" } }, "database", {})).toBe("__database.func")
    expect(resolveNitroVercelFunctionName({}, "workflow", { NITRO_PRESET: "vercel" })).toBe("__workflow.func")
    expect(resolveNitroVercelFunctionName({}, "queue", { SERVER_PRESET: "vercel-edge" })).toBe("__queue.func")
    expect(resolveNitroVercelFunctionName({
      environments: { client: { build: { outDir: ".vercel/output/static" } } },
      plugins,
    }, "blob", {})).toBe("__blob.func")
    expect(resolveNitroVercelFunctionName({ plugins: [{ name: "vitehub" }] }, "blob", { VERCEL: "1" })).toBeUndefined()
    expect(resolveNitroVercelFunctionName({}, "blob", { VITEHUB_HOSTING: "vercel" })).toBeUndefined()
    expect(resolveNitroVercelFunctionName({ plugins, nitro: { preset: "node-server" } }, "blob", {})).toBeUndefined()
    expect(resolveNitroVercelFunctionName({ plugins, nitro: { preset: "node-server" } }, "blob", { VERCEL: "1" })).toBeUndefined()
    expect(resolveNitroVercelFunctionName({ plugins, nitro: { preset: "cloudflare" } }, "blob", { VITEHUB_HOSTING: "vercel" })).toBeUndefined()
  })
})
