import { afterEach, describe, expect, it, vi } from "vitest"

import { getViteMode, VITEHUB_MODES, VITEHUB_VITE_MODE_KEY } from "../src/build/mode.ts"

const originalArgv = process.argv

afterEach(() => {
  vi.unstubAllEnvs()
  process.argv = originalArgv
})

describe("ViteHub build mode", () => {
  it("reads explicit ViteHub mode from env", () => {
    vi.stubEnv(VITEHUB_VITE_MODE_KEY, VITEHUB_MODES.schedule)

    expect(getViteMode()).toBe(VITEHUB_MODES.schedule)
  })

  it("reads Vite CLI --mode values for direct Vite builds", () => {
    process.argv = ["/usr/bin/node", "/workspace/node_modules/.bin/vite", "build", "--mode", "schedule"]

    expect(getViteMode()).toBe(VITEHUB_MODES.schedule)
  })

  it("does not read --mode values from non-Vite commands", () => {
    process.argv = ["/usr/bin/node", "/workspace/node_modules/.bin/vitest", "run", "--mode", "schedule"]

    expect(getViteMode()).toBeUndefined()
  })
})
