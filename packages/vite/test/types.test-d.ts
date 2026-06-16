import { describe, expectTypeOf, it } from "vitest"

import { vitehub } from "../src/index.ts"

import type { Plugin } from "vite"

describe("vitehub types", () => {
  it("returns Vite plugins", () => {
    expectTypeOf(vitehub()).toEqualTypeOf<Plugin[]>()
  })
})
