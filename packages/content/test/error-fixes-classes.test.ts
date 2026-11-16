import { expect, it } from "vitest"

import { contentErrorDiagnostics } from "../src/error-diagnostics.ts"
import { contentScheduleCancelled } from "../src/schedules.ts"

it("gives each code that replaced an error class a fix and its own docs page", () => {
  for (const error of [contentErrorDiagnostics.CONTENT_FORBIDDEN({ action: "edit", target: "document" }), contentScheduleCancelled()]) {
    expect(error.message).toMatch(/\S/)
    expect(Reflect.get(error, "fix")).toMatch(/\S/)
    expect(Reflect.get(error, "docs")).toBe(`https://vitehub.dev/docs/content/diagnostics/${String(Reflect.get(error, "code")).toLowerCase()}`)
  }
  expect(contentErrorDiagnostics.CONTENT_FORBIDDEN({ action: "edit", target: "document" }).message).toBe("You cannot edit this document.")
})
