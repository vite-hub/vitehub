import { describe, expect, it } from "vitest"

import { assertNoNitroModule, assertNoVitePlugin, assertNoVitePluginInNitro, hasNamedVitePlugin, hasNitroModule } from "../src/nitro.ts"

describe("integration boundary helpers", () => {
  it("finds named Vite plugins in nested plugin arrays", async () => {
    await expect(hasNamedVitePlugin([
      { name: "other" },
      [{ name: "@vitehub/kv/vite" }],
    ], "@vitehub/kv/vite")).resolves.toBe(true)
  })

  it("finds named Vite plugins behind plugin promises", async () => {
    await expect(hasNamedVitePlugin([
      Promise.resolve({ name: "other" }),
      Promise.resolve([{ name: "@vitehub/kv/vite" }]),
    ], "@vitehub/kv/vite")).resolves.toBe(true)
  })

  it("finds Nitro modules by id, module object, and Vite bridge object", () => {
    expect(hasNitroModule("@vitehub/kv/nitro", "@vitehub/kv/nitro", "@vitehub/kv")).toBe(true)
    expect(hasNitroModule({ name: "@vitehub/kv" }, "@vitehub/kv/nitro", "@vitehub/kv")).toBe(true)
    expect(hasNitroModule({ nitro: { name: "@vitehub/kv" } }, "@vitehub/kv/nitro", "@vitehub/kv")).toBe(true)
  })

  it("rejects direct Vite plugins when a framework integration owns setup", async () => {
    await expect(assertNoVitePlugin({
      plugins: [{ name: "@vitehub/kv/vite" }],
    }, "@vitehub/kv/vite", "@vitehub/kv/nuxt")).rejects.toThrow(
      "[vitehub] Do not configure @vitehub/kv/vite when using @vitehub/kv/nuxt.",
    )
  })

  it("rejects promised Vite plugins when a framework integration owns setup", async () => {
    await expect(assertNoVitePlugin({
      plugins: [Promise.resolve({ name: "@vitehub/kv/vite" })],
    }, "@vitehub/kv/vite", "@vitehub/kv/nuxt")).rejects.toThrow(
      "[vitehub] Do not configure @vitehub/kv/vite when using @vitehub/kv/nuxt.",
    )
  })

  it("rejects direct Vite plugins from Nitro options", async () => {
    await expect(assertNoVitePluginInNitro({
      options: {
        vite: {
          plugins: [{ name: "@vitehub/kv/vite" }],
        },
      },
    }, "@vitehub/kv/vite", "@vitehub/kv/nitro")).rejects.toThrow(
      "[vitehub] Do not configure @vitehub/kv/vite when using @vitehub/kv/nitro.",
    )
  })

  it("rejects direct Nitro modules when Nuxt owns setup", () => {
    expect(() => assertNoNitroModule({
      modules: ["@vitehub/kv/nitro"],
    }, "@vitehub/kv/nitro", "@vitehub/kv", "@vitehub/kv/nuxt")).toThrow(
      "[vitehub] Do not configure @vitehub/kv/nitro when using @vitehub/kv/nuxt.",
    )
  })
})
