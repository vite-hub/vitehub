import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as v from "valibot"
import { expect, it } from "vitest"

import { formsDiagnostics } from "../src/errors.ts"
import { defineForm } from "../src/index.ts"
import { discoverForms } from "../src/vite.ts"

const fixedCodes = ["FORMS_B0001", "FORMS_C0001"] as const

it("gives each Forms build and definition code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = formsDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/forms/diagnostics/${code.toLowerCase()}`)
  }
})

it("names defineForm() when a form option is not valid", () => {
  expect(() => defineForm({ rateLimit: { limit: 0, window: "1m" }, schema: v.object({ email: v.string() }) })).toThrow(expect.objectContaining({
    code: "FORMS_C0001",
    fix: expect.stringContaining("`defineForm()`"),
  }))
})

it("names server/forms/ when a form file has a name that is not a route segment", () => {
  const root = mkdtempSync(join(tmpdir(), "vitehub-forms-error-fixes-"))
  mkdirSync(join(root, "server/forms"), { recursive: true })
  writeFileSync(join(root, "server/forms/Contact.ts"), "export default {}\n")

  expect(() => discoverForms(root)).toThrow(expect.objectContaining({
    code: "FORMS_B0001",
    fix: expect.stringContaining("`server/forms/`"),
  }))
})
