import { describe, expect, it } from "vitest"

import config from "../vitest.config"

describe("Agent test configuration", () => {
  it("serializes timing-sensitive Agent test files", () => {
    expect(config.test?.fileParallelism).toBe(false)
  })
})
