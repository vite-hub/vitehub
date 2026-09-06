import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ initDevframe: vi.fn() }))

vi.mock("devframe/initiate", () => ({ initDevframe: mocks.initDevframe }))

describe("Console Devframe module", () => {
  it("does not initialize Devframe in the host runtime's global scope", async () => {
    await import("../src/console/runtime/server/devframe.ts")

    expect(mocks.initDevframe).not.toHaveBeenCalled()
  })
})
