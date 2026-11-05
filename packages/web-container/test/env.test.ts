import { afterEach, expect, it } from "vitest"

import { isWebContainer } from "../src/env.ts"

afterEach(() => {
  delete (process.versions as Record<string, string | undefined>).webcontainer
})

it("reports false on host Node", () => {
  expect(isWebContainer()).toBe(false)
})

it("reports true where the WebContainer runtime sets its version", () => {
  Object.assign(process.versions, { webcontainer: "1.0.0" })
  expect(isWebContainer()).toBe(true)
})
