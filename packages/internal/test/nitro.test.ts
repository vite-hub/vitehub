import { describe, expect, it } from "vitest"

import { assertNoNitroModule, assertNoVitePlugin, assertNoVitePluginInNitro, hasNamedVitePlugin, hasNitroModule } from "../src/nitro.ts"

describe("integration boundary helpers", () => {
  it("finds named Vite plugins in nested plugin arrays", async () => {
    await expect(hasNamedVitePlugin([
      { name: "other" },
      [{ name: "@vite-hub/kv/vite" }],
    ], "@vite-hub/kv/vite")).resolves.toBe(true)
  })

  it("finds named Vite plugins behind plugin promises", async () => {
    await expect(hasNamedVitePlugin([
      Promise.resolve({ name: "other" }),
      Promise.resolve([{ name: "@vite-hub/kv/vite" }]),
    ], "@vite-hub/kv/vite")).resolves.toBe(true)
  })

  it("finds Nitro modules by id, module object, and Vite bridge object", () => {
    expect(hasNitroModule("@vite-hub/kv/nitro", "@vite-hub/kv/nitro", "@vite-hub/kv")).toBe(true)
    expect(hasNitroModule({ name: "@vite-hub/kv" }, "@vite-hub/kv/nitro", "@vite-hub/kv")).toBe(true)
    expect(hasNitroModule({ nitro: { name: "@vite-hub/kv" } }, "@vite-hub/kv/nitro", "@vite-hub/kv")).toBe(true)
  })

  it("rejects direct Vite plugins when a framework integration owns setup", async () => {
    await expect(assertNoVitePlugin({
      plugins: [{ name: "@vite-hub/kv/vite" }],
    }, "@vite-hub/kv/vite", "@vite-hub/kv/nuxt")).rejects.toThrow(
      "[vitehub] Do not configure @vite-hub/kv/vite when using @vite-hub/kv/nuxt.",
    )
  })

  it("rejects promised Vite plugins when a framework integration owns setup", async () => {
    await expect(assertNoVitePlugin({
      plugins: [Promise.resolve({ name: "@vite-hub/kv/vite" })],
    }, "@vite-hub/kv/vite", "@vite-hub/kv/nuxt")).rejects.toThrow(
      "[vitehub] Do not configure @vite-hub/kv/vite when using @vite-hub/kv/nuxt.",
    )
  })

  it("rejects direct Vite plugins from Nitro options", async () => {
    await expect(assertNoVitePluginInNitro({
      options: {
        vite: {
          plugins: [{ name: "@vite-hub/kv/vite" }],
        },
      },
    }, "@vite-hub/kv/vite", "@vite-hub/kv/nitro")).rejects.toThrow(
      "[vitehub] Do not configure @vite-hub/kv/vite when using @vite-hub/kv/nitro.",
    )
  })

  it("rejects direct Nitro modules when Nuxt owns setup", () => {
    expect(() => assertNoNitroModule({
      modules: ["@vite-hub/kv/nitro"],
    }, "@vite-hub/kv/nitro", "@vite-hub/kv", "@vite-hub/kv/nuxt")).toThrow(
      "[vitehub] Do not configure @vite-hub/kv/nitro when using @vite-hub/kv/nuxt.",
    )
  })
})
