import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { FormSubmitError, chatModalErrors, checkForm, createMemoryFormsStore, defineForm, formFields, handleFormRequest, readChatModal, toChatModal } from "../src/index.ts"

describe("a schema with no JSON Schema", () => {
  const Custom = z.object({ name: z.custom<string>(value => typeof value === "string") })

  it("still validates a form-data post", async () => {
    const store = createMemoryFormsStore()
    const response = await handleFormRequest("custom", defineForm({ schema: Custom }), new Request("https://site.test/api/_vitehub/forms/custom", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: "name=Ada",
    }), { store })
    expect(response.status).toBe(201)
    expect((await store.list())[0]?.data).toEqual({ name: "Ada" })
  })

  it("throws FORMS_C0002 when a surface draws it", () => {
    expect(() => formFields(Custom)).toThrow(expect.objectContaining({ code: "FORMS_C0002" }))
    expect(() => toChatModal(Custom, { callbackId: "custom", title: "Custom" })).toThrow(expect.objectContaining({ code: "FORMS_C0002" }))
  })
})

describe("readChatModal", () => {
  it("keeps an empty text answer, as a web form sends it", async () => {
    expect(await readChatModal(v.object({ note: v.string() }), { note: "" })).toEqual(await checkForm(v.object({ note: v.string() }), { note: "" }))
    const Short = v.object({ note: v.pipe(v.string(), v.minLength(2, "Write a little more.")) })
    const [error] = await readChatModal(Short, { note: "" })
    expect(error?.issues).toEqual([{ message: "Write a little more.", path: ["note"] }])
  })

  it("leaves out an empty number or choice, and reads an empty Yes or No as false", async () => {
    const Form = v.object({ seats: v.optional(v.number()), size: v.optional(v.picklist(["s", "m"])), updates: v.optional(v.boolean()) })
    expect(await readChatModal(Form, { seats: "", size: "", updates: "" })).toEqual([undefined, { updates: false }])
  })
})

describe("chatModalErrors", () => {
  const Range = v.pipe(
    v.object({ start: v.number(), end: v.number() }),
    v.check(value => value.start < value.end, "Start must be before end."),
  )

  it("shows an error of the whole form under the first input", async () => {
    const [error] = await readChatModal(Range, { start: "2", end: "1" })
    expect(error && chatModalErrors(error, Range)).toEqual({ action: "errors", errors: { start: "Start must be before end." } })
  })

  it("keeps the error of the first field before the error of the whole form", () => {
    const error = new FormSubmitError("Check the form and try again.", 400, [{ message: "Required.", path: ["start"] }, { message: "Start must be before end.", path: [] }])
    expect(chatModalErrors(error, Range).errors).toEqual({ start: "Required. Start must be before end." })
  })
})
