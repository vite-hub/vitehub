import { expect, it, vi } from "vitest"

// Each mock fails the import when vite-hub/nuxt loads that module before a build needs it.
vi.mock("esbuild", () => {
  throw new Error("loaded esbuild")
})
vi.mock("semver/functions/satisfies.js", () => {
  throw new Error("loaded semver")
})
vi.mock("semver/ranges/valid.js", () => {
  throw new Error("loaded semver")
})
// An app without feature packages.
vi.mock("../src/internal/optional-owners.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../src/internal/optional-owners.ts")>(),
  importOptionalOwner: async () => undefined,
}))

it("loads vite-hub/nuxt without esbuild or semver, which only some builds use", async () => {
  await expect(import("../src/nuxt.ts")).resolves.toHaveProperty("default")
})
