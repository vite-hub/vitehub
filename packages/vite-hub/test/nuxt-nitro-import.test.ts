import { expect, it, vi } from "vitest"

vi.mock("nitro/vite", () => {
  throw new Error("loaded nitro/vite")
})
// An app without feature packages. Comments, for one, includes Nitro for its own live server.
vi.mock("../src/internal/optional-owners.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../src/internal/optional-owners.ts")>(),
  importOptionalOwner: async () => undefined,
}))

it("loads vite-hub/nuxt without Nitro's Vite plugin, which Nuxt replaces with its own Nitro", async () => {
  await expect(import("../src/nuxt.ts")).resolves.toHaveProperty("default")
  // `vitehub()` includes Nitro, so the Vite entry still loads it.
  await expect(import("../src/index.ts")).rejects.toHaveProperty("cause.message", "loaded nitro/vite")
})
