import { expect, it } from "vitest"

import { formsDiagnostics } from "../src/errors.ts"
import { createFormsInbox } from "../src/inbox.ts"
import { createMemoryFormsStore } from "../src/memory.ts"
import { describeFormFields } from "../src/vue.ts"

/** The codes that replaced plain errors in the inbox, the operations, the runtime, and AutoForm. */
const codes = [
  "FORMS_AUTOFORM_SCHEMA_INVALID",
  "FORMS_DATABASE_MISSING",
  "FORMS_NOT_INSTALLED",
  "FORMS_SUBMISSION_STATUS_INVALID",
] as const

it.each(codes)("gives %s a fix and its own docs page", (code) => {
  // Each code takes its own params. One object that has all of them fits every code.
  const create = formsDiagnostics[code] as (params: { database: string, status: string }) => Error & { docs?: string, fix?: string }
  const error = create({ database: "forms", status: "\"closed\"" })
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe(`https://vitehub.dev/docs/forms/diagnostics/${code.toLowerCase()}`)
})

it("returns an unknown submission status with its code and fix", async () => {
  const inbox = createFormsInbox(createMemoryFormsStore())
  // SAFETY: the test passes a status that the type forbids, as a JavaScript caller can.
  const [error] = await inbox.setStatus("missing", "closed" as never)
  expect(error).toMatchObject({
    code: "FORMS_SUBMISSION_STATUS_INVALID",
    fix: expect.stringContaining("`spam`"),
    message: "[vitehub] A form submission status is open, done, or spam, not \"closed\".",
  })
})

it("reports an AutoForm schema that is not an object with its code and fix", () => {
  expect(() => describeFormFields({ type: "string" })).toThrow(expect.objectContaining({
    code: "FORMS_AUTOFORM_SCHEMA_INVALID",
    fix: expect.stringContaining("v.object("),
  }))
})
