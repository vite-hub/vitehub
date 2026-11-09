// @vitest-environment happy-dom
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, nextTick } from "vue"

import { createMemoryFormsStore, defineForm, handleFormRequest } from "../src/index.ts"
import { AutoForm, describeFormFields } from "../src/vue.ts"

const ContactSchema = v.object({
  email: v.pipe(v.string(), v.email("Enter a valid email.")),
  topic: v.picklist(["bug", "idea"]),
  message: v.pipe(v.string(), v.title("Your message"), v.description("A few lines is plenty."), v.minLength(5, "Write a little more.")),
  newsletter: v.optional(v.boolean()),
})

describe("describeFormFields", () => {
  it("reads controls, labels, and required fields from a Valibot object", () => {
    expect(describeFormFields(ContactSchema)).toEqual([
      { key: "email", label: "Email", control: "input", inputType: "email", required: true },
      { key: "topic", label: "Topic", control: "select", options: ["bug", "idea"], required: true },
      { key: "message", label: "Your message", description: "A few lines is plenty.", control: "textarea", required: true },
      { key: "newsletter", label: "Newsletter", control: "checkbox", required: false },
    ])
    expect(describeFormFields(v.object({ name: v.optional(v.pipe(v.string(), v.maxLength(80))), site: v.pipe(v.string(), v.url()), age: v.number(), notes: v.pipe(v.string(), v.maxLength(1000)) })).map(field => [field.key, field.control, field.inputType, field.required])).toEqual([
      ["name", "input", "text", false],
      ["site", "input", "url", true],
      ["age", "input", "number", true],
      ["notes", "textarea", undefined, true],
    ])
    expect(() => describeFormFields(v.string())).toThrow("Valibot object schema")
    // A TypeScript numeric enum has reverse keys. The select lists only its values, with their type.
    enum Size { Small = 1, Large = 2 }
    expect(describeFormFields(v.object({ size: v.enum(Size), count: v.picklist([1, 2]) })).map(field => field.options)).toEqual([[1, 2], [1, 2]])
  })
})

describe("AutoForm", () => {
  afterEach(() => {
    document.body.innerHTML = ""
    vi.unstubAllGlobals()
  })

  async function mount(serverSchema: v.GenericSchema<unknown, Record<string, unknown>> = ContactSchema, clientSchema: v.ObjectSchema<v.ObjectEntries, undefined> = ContactSchema) {
    const store = createMemoryFormsStore()
    const form = defineForm({ schema: serverSchema })
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => handleFormRequest("contact", form, new Request(new URL(String(input), location.origin), init), { store }))
    const root = document.createElement("div")
    document.body.append(root)
    const sent = vi.fn()
    createApp(AutoForm, { name: "contact", schema: clientSchema, onSent: sent }).mount(root)
    await nextTick()
    const element = <T extends Element>(selector: string) => root.querySelector<T>(selector)!
    const type = async (selector: string, value: string) => {
      const input = element<HTMLInputElement>(selector)
      input.value = value
      input.dispatchEvent(new Event(input.tagName === "SELECT" ? "change" : "input"))
      await nextTick()
    }
    const submit = async () => {
      element<HTMLFormElement>("form").dispatchEvent(new Event("submit", { cancelable: true }))
      await vi.waitFor(async () => {
        await nextTick()
        if (root.querySelector("button")?.hasAttribute("disabled")) throw new Error("still sending")
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      await nextTick()
    }
    return { root, store, sent, element, type, submit }
  }

  it("draws labelled controls, the honeypot, and the submit button", async () => {
    const { root } = await mount()
    expect([...root.querySelectorAll("label")].map(label => label.textContent)).toEqual(["Email", "Topic", "Your message", " Newsletter"])
    expect(root.querySelector("#vitehub-form-contact-email")?.getAttribute("type")).toBe("email")
    expect(root.querySelector("#vitehub-form-contact-message")?.tagName).toBe("TEXTAREA")
    expect(root.querySelector("#vitehub-form-contact-message")?.getAttribute("aria-describedby")).toBe("vitehub-form-contact-message-help")
    expect(root.querySelector("input[name=website]")?.getAttribute("tabindex")).toBe("-1")
    expect(root.querySelector("button[type=submit]")?.textContent).toBe("Send")
  })

  it("shows client errors under each field and sends nothing", async () => {
    const { root, store, submit, type } = await mount()
    await type("#vitehub-form-contact-email", "nope")
    await submit()
    expect(root.querySelector("[data-field=email] [data-error]")?.textContent).toBe("Enter a valid email.")
    expect(root.querySelector("#vitehub-form-contact-email")?.getAttribute("aria-invalid")).toBe("true")
    expect(await store.list()).toEqual([])
  })

  it("sends valid values, stores them, and shows the sent message", async () => {
    const { root, store, sent, submit, type } = await mount()
    await type("#vitehub-form-contact-email", "ada@example.com")
    await type("#vitehub-form-contact-topic", "1")
    await type("#vitehub-form-contact-message", "Add dark mode.")
    await submit()
    expect((await store.list()).map(row => row.data)).toEqual([{ email: "ada@example.com", topic: "idea", message: "Add dark mode." }])
    expect(root.querySelector("[data-sent]")?.textContent).toBe("Thanks. Your message was sent.")
    expect(sent).toHaveBeenCalledWith(expect.any(String))
  })

  it("sends an unchecked box as false, a number option as a number, and the input before transforms", async () => {
    // The server parses the text again, so the client must send the text, not the number of `toNumber()`.
    const schema = v.object({
      age: v.pipe(v.string(), v.toNumber()),
      count: v.picklist([1, 2]),
      terms: v.boolean(),
    })
    const { root, store, submit, type } = await mount(schema, schema)
    await type("#vitehub-form-contact-age", "42")
    await type("#vitehub-form-contact-count", "1")
    await submit()
    expect(root.querySelector("[data-error]")).toBeNull()
    expect((await store.list()).map(row => row.data)).toEqual([{ age: 42, count: 2, terms: false }])
  })

  it("puts a server issue under its field", async () => {
    // The server is stricter than the client, as when a server rule changes first.
    const strict = v.object({ ...ContactSchema.entries, message: v.pipe(v.string(), v.minLength(50, "Tell us more on the server.")) })
    const { root, store, submit, type } = await mount(strict)
    await type("#vitehub-form-contact-email", "ada@example.com")
    await type("#vitehub-form-contact-topic", "0")
    await type("#vitehub-form-contact-message", "Short but valid here.")
    await submit()
    expect(root.querySelector("[data-field=message] [data-error]")?.textContent).toBe("Tell us more on the server.")
    expect(await store.list()).toEqual([])
  })
})
