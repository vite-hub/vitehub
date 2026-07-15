import { describe, expect, it } from "vitest"

import { vitehub as frameworkViteHub } from "vite-hub"
import { vitehub } from "../src/index.ts"

describe("@vite-hub/vite compatibility", () => {
  it("forwards the canonical framework entry without another implementation", () => {
    expect(vitehub).toBe(frameworkViteHub)
  })
})
