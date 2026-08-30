import { describe, expect, it } from "vitest"

import { processExitCompletedDrain } from "../src/internal/drain.ts"

describe("process drain command", () => {
  it("accepts a clean process exit after signaling drain", () => {
    expect(processExitCompletedDrain(true)).toBe(true)
  })

  it("rejects a process exit before signaling drain", () => {
    expect(processExitCompletedDrain(false)).toBe(false)
  })
})
