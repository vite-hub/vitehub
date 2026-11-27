import { describe, expect, it, vi } from "vitest"

vi.mock("vite-hub/browser", () => ({ isBrowserAvailable: () => false, runBrowserAction: vi.fn() }))

const aliases = { "vite-hub/source/glob": "./stubs/glob.ts" }

describe("screenshot", () => {
  it("skips without a browser", async () => {
    const { screenshot } = await import("../server/utils/screenshot.ts")
    expect(await screenshot("https://example.com")).toBeUndefined()
    expect(aliases).toBeDefined()
  })
})
