import { expect, it } from "vitest"

import { realtimeErrorDiagnostics } from "../src/error-diagnostics.ts"

it("gives each code that replaced a plain error a fix and its own docs page", () => {
  for (const error of [realtimeErrorDiagnostics.REALTIME_ROOM_WRITE_CONFLICT(), realtimeErrorDiagnostics.REALTIME_WRITE_REJECTED({ problem: "status" })]) {
    expect(error.message).toMatch(/\S/)
    expect(error.fix).toMatch(/\S/)
    expect(error.docs).toBe(`https://vitehub.dev/docs/realtime/diagnostics/${error.code.toLowerCase()}`)
  }
  expect(realtimeErrorDiagnostics.REALTIME_WRITE_REJECTED({ problem: "read-only", readOnly: "Ask the owner." }).message).toBe("Ask the owner.")
})
