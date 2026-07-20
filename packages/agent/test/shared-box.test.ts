import type { Box, BoxSession } from "@vite-hub/box"
import { describe, expect, it, vi } from "vitest"

import { isHarnessBoxActive, openHarnessBox, shareBoxSessions } from "../src/harness/shared-box.ts"

describe("shared Box sessions", () => {
  it("distinguishes a prepared Harness tree from a direct Box session", async () => {
    const session = { close: vi.fn() } as unknown as BoxSession
    const box = shareBoxSessions({
      open: vi.fn(async options => {
        await options?.initialize?.(session, {})
        return session
      }),
      plan: {} as Box["plan"],
    })

    expect(isHarnessBoxActive(box)).toBe(false)
    const direct = await box.open()
    expect(isHarnessBoxActive(box)).toBe(false)
    await direct.close()

    const harness = await openHarnessBox(box)
    expect(isHarnessBoxActive(box)).toBe(true)
    await harness.close()
    expect(isHarnessBoxActive(box)).toBe(false)
  })
})
