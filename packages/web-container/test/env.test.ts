import { expect, it } from "vitest"

import { isWebContainer } from "../src/env.ts"

it("reports false on host Node", () => {
  expect(isWebContainer()).toBe(false)
})
