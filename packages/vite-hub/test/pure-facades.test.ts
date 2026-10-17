import { describe, expect, it } from "vitest"

// Each vite-hub subpath here re-exports its owner package. Both import paths must give the same values.
const facades = [
  {
    facade: () => import("../src/runtime/h3.ts"),
    name: "vite-hub/runtime/h3",
    owners: [() => import("@vite-hub/runtime/h3")],
  },
  {
    facade: () => import("../src/source.ts"),
    name: "vite-hub/source",
    owners: [() => import("@vite-hub/source"), () => import("@vite-hub/source/drizzle")],
  },
  {
    facade: () => import("../src/source/server.ts"),
    name: "vite-hub/source/server",
    owners: [() => import("@vite-hub/source/server")],
  },
]

describe("pure vite-hub facades", () => {
  for (const { facade, name, owners } of facades) {
    it(`${name} exports the owner values unchanged`, async () => {
      const facadeModule: Record<string, unknown> = { ...await facade() }
      const ownerModule: Record<string, unknown> = Object.assign({}, ...await Promise.all(owners.map(owner => owner())))

      expect(Object.keys(facadeModule).sort()).toEqual(Object.keys(ownerModule).sort())
      for (const [key, value] of Object.entries(ownerModule)) {
        expect(facadeModule[key], `${name} ${key}`).toBe(value)
      }
    })
  }
})
