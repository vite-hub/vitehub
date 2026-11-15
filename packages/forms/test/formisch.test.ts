// @vitest-environment happy-dom
import { getErrors, getInput, setInput, useForm } from "@formisch/vue"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent } from "vue"

import { createMemoryFormsStore, defineForm, handleFormRequest } from "../src/index.ts"
import { useFormSubmit } from "../src/formisch.ts"

import type { FormStore } from "@formisch/vue"

const Contact = v.object({
  email: v.pipe(v.string(), v.email("Enter a valid email.")),
  message: v.pipe(v.string(), v.minLength(5, "Write a little more.")),
})

afterEach(() => vi.unstubAllGlobals())

function mount(server: v.GenericSchema<unknown, Record<string, unknown>> = Contact) {
  const store = createMemoryFormsStore()
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => handleFormRequest("contact", defineForm({ schema: server }), new Request(new URL(String(input), location.origin), init), { store }))
  let form!: FormStore<typeof Contact>
  let submit!: ReturnType<typeof useFormSubmit>
  createApp(defineComponent({
    setup() {
      form = useForm({ schema: Contact })
      submit = useFormSubmit("contact", form)
      return () => null
    },
  })).mount(document.createElement("div"))
  return { form, submit, store }
}

describe("useFormSubmit", () => {
  it("sends the input of a Formisch form and resets it after a success", async () => {
    const { form, submit, store } = mount()
    setInput(form, { input: { email: "ada@example.com", message: "Hello there" } })
    await submit.send()
    expect((await store.list()).map(row => row.data)).toEqual([{ email: "ada@example.com", message: "Hello there" }])
    expect(submit.sent.value).toEqual(expect.any(String))
    expect(getInput(form)).toEqual({ email: "", message: "" })
  })

  it("puts a server issue under its field", async () => {
    const strict = v.object({ ...Contact.entries, message: v.pipe(v.string(), v.minLength(50, "Tell us more on the server.")) })
    const { form, submit, store } = mount(strict)
    setInput(form, { input: { email: "ada@example.com", message: "Short but valid here." } })
    await submit.send()
    expect(getErrors(form, { path: ["message"] })).toEqual(["Tell us more on the server."])
    expect(submit.error.value?.status).toBe(400)
    expect(await store.list()).toEqual([])
  })
})
