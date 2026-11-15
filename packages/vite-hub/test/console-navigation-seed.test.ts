import { describe, expect, it, vi } from "vitest"

import { seedConsoleNavigation, subscribeConsoleNavigation } from "../src/console/runtime/client/sections"

import type { ConsoleNavigation } from "../src/console/runtime/client/sections"

vi.mock("../src/console/runtime/client/request", () => ({ requestConsole: vi.fn() }))

const navigation: ConsoleNavigation = { contributions: {}, operations: [], readOnly: [], scoped: false, sections: ["auth"] }

describe("seedConsoleNavigation", () => {
  it("gives the seeded navigation to a subscriber that comes later, such as the router that adds the section routes", () => {
    seedConsoleNavigation("/seeded", navigation)
    const subscriber = vi.fn()
    const stop = subscribeConsoleNavigation("/seeded", subscriber)
    expect(subscriber).toHaveBeenCalledWith(navigation)
    stop()
  })

  it("gives nothing to a subscriber of a base without a navigation yet", () => {
    const subscriber = vi.fn()
    subscribeConsoleNavigation("/empty", subscriber)()
    expect(subscriber).not.toHaveBeenCalled()
  })
})
