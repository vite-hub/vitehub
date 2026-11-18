import { expect, it } from "vitest"

import { channelsErrorDiagnostics } from "../src/error-diagnostics.ts"
import { useChannel } from "../src/index.ts"

const fixedCodes = [
  "CHANNELS_R0002",
  "CHANNELS_R0003",
] as const

it("gives each Channels runtime code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = channelsErrorDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/channels/diagnostics/${code.toLowerCase()}`)
  }
})

it("tells the developer to pass a Channel name to useChannel()", () => {
  expect(() => useChannel("" as never)).toThrow(expect.objectContaining({
    code: "CHANNELS_R0003",
    fix: expect.stringContaining("`useChannel()`"),
  }))
})
