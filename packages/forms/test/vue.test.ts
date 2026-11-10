// @vitest-environment happy-dom
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, createSSRApp, h, nextTick } from "vue"
import { renderToString } from "vue/server-renderer"

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
      { key: "message", label: "Your message", description: "A few lines is plenty.", control: "textarea", required: true, minLength: 5 },
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
    const app = createApp(AutoForm, { name: "contact", schema: clientSchema, onSent: sent })
    app.mount(root)
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
      // AutoForm validates before Formisch marks the form as submitting, so let that run first.
      await new Promise(resolve => setTimeout(resolve, 10))
      await vi.waitFor(async () => {
        await nextTick()
        if (root.querySelector("button")?.getAttribute("aria-disabled") === "true") throw new Error("still sending")
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      await nextTick()
    }
    return { app, root, store, sent, element, type, submit }
  }

  it("draws labelled controls, the honeypot, and the submit button", async () => {
    const { root } = await mount()
    expect([...root.querySelectorAll("label")].map(label => label.textContent)).toEqual(["Email", "Topic", "Your message", " Newsletter"])
    expect(root.querySelector("[data-field=email] :is(input, select, textarea)")?.getAttribute("type")).toBe("email")
    expect(root.querySelector("[data-field=message] :is(input, select, textarea)")?.tagName).toBe("TEXTAREA")
    const message = root.querySelector("[data-field=message] :is(input, select, textarea)")!
    expect(root.querySelector(`#${message.getAttribute("aria-describedby")}`)?.textContent).toBe("A few lines is plenty.")
    // Without JavaScript, or before it loads, the form posts to its route.
    expect([root.querySelector("form")?.getAttribute("method"), root.querySelector("form")?.getAttribute("action")]).toEqual(["post", "/api/_vitehub/forms/contact"])
    // The live region is there before the message, so screen readers announce it.
    expect(root.querySelector("[role=status]")?.textContent).toBe("")
    expect(root.querySelector("input[name=website]")?.getAttribute("tabindex")).toBe("-1")
    expect(root.querySelector("button[type=submit]")?.textContent).toBe("Send")
  })

  it("shows client errors under each field and sends nothing", async () => {
    const { root, store, submit, type } = await mount()
    await type("[data-field=email] :is(input, select, textarea)", "nope")
    // When focus arrives, the field already points to its error, so a screen reader reads it.
    const described: (string | null)[] = []
    root.querySelector("[data-field=email] input")!.addEventListener("focus", event => described.push((event.target as Element).getAttribute("aria-describedby")))
    await submit()
    expect(document.activeElement).toBe(root.querySelector("[data-field=email] input"))
    expect(described.at(-1)).toContain("-error")
    expect(root.querySelector("[data-field=email] [data-error]")?.textContent).toBe("Enter a valid email.")
    expect(root.querySelector("[data-field=email] :is(input, select, textarea)")?.getAttribute("aria-invalid")).toBe("true")
    // One announcement: focus goes to the field, which reads its error. Field errors are not alerts.
    expect(root.querySelectorAll("[data-field] [role=alert]")).toHaveLength(0)
    expect(await store.list()).toEqual([])
    // The form is submitted, so fixing the field clears its error as the user types.
    await type("[data-field=email] :is(input, select, textarea)", "ada@example.com")
    await vi.waitFor(() => expect(root.querySelector("[data-field=email] [data-error]")).toBeNull())
    expect(root.querySelector("[data-field=email] input")?.hasAttribute("aria-invalid")).toBe(false)
  })

  it("renders the result of a post without JavaScript on the server", async () => {
    // No mount on the server: the route query comes in as `result`.
    const html = await renderToString(createSSRApp(AutoForm, { name: "contact", schema: ContactSchema, result: "contact.error" }))
    expect(html).toContain("The message was not sent. Check the form and try again.")
    // Until the app runs, the browser checks `required` and `type` itself.
    expect(html).not.toContain("novalidate")
    // A number input allows decimals, as `v.number()` does.
    expect(await renderToString(createSSRApp(AutoForm, { name: "contact", schema: v.object({ price: v.number() }) }))).toContain('step="any"')
    // The browser checks lengths too, so a short message is not lost to a round trip.
    expect(html).toContain('minlength="5"')
    // An empty select shows "Choose one", not its first option, before the app runs.
    expect(html).toMatch(/<option value(="")? disabled selected>Choose one<\/option>/)
    expect(html).not.toMatch(/<option value="bug" selected/)
  })

  it.each([
    ["required", v.picklist(["bug", "undefined"])],
    ["optional", v.optional(v.picklist(["bug", "undefined"]))],
    ["nullable", v.nullable(v.picklist(["bug", "null"]), null)],
  ])("keeps an empty %s select distinct from literal nullish choices in server HTML", async (_name, choice) => {
    const root = document.createElement("div")
    root.innerHTML = await renderToString(createSSRApp(AutoForm, { name: "contact", schema: v.object({ topic: choice }) }))
    const selected = root.querySelectorAll("option[selected]")
    expect(selected).toHaveLength(1)
    expect(selected[0]?.textContent).toBe("Choose one")
  })

  it.each(["undefined", "null"])("keeps the literal %s choice selectable in server HTML", async (value) => {
    const schema = v.object({ topic: v.optional(v.picklist(["bug", value]), value) })
    const root = document.createElement("div")
    root.innerHTML = await renderToString(createSSRApp(AutoForm, { name: "contact", schema }))
    expect([...root.querySelectorAll("option[selected]")].map(option => option.textContent)).toEqual([value])
  })

  it("shows the result of a post without JavaScript and keeps the button label while it sends", async () => {
    history.replaceState(null, "", "/contact?form=contact.error")
    try {
      const { root, type, element } = await mount()
      await nextTick()
      expect(root.querySelector("[role=status]")?.textContent).toBe("The message was not sent. Check the form and try again.")
      // The page loads at the top, so focus moves to the result. The app's own checks take over.
      expect(document.activeElement).toBe(root.querySelector("[role=status]"))
      // A reload must not show it again.
      expect(location.search).toBe("")
      expect(root.querySelector("form")?.hasAttribute("novalidate")).toBe(true)
      await type("[data-field=email] :is(input, select, textarea)", "ada@example.com")
      await type("[data-field=topic] :is(input, select, textarea)", "idea")
      await type("[data-field=message] :is(input, select, textarea)", "Add dark mode.")
      element<HTMLFormElement>("form").dispatchEvent(new Event("submit", { cancelable: true }))
      await nextTick()
      // The old result goes away, and the label does not change, so the button keeps its width.
      expect(root.querySelector("[role=status]")?.textContent).toBe("")
      expect(root.querySelector("button")?.textContent).toBe("Send")
    }
    finally {
      history.replaceState(null, "", "/")
    }
  })

  it("sends valid values, stores them, and shows the sent message", async () => {
    const { root, store, sent, submit, type } = await mount()
    await type("[data-field=email] :is(input, select, textarea)", "ada@example.com")
    await type("[data-field=topic] :is(input, select, textarea)", "idea")
    await type("[data-field=message] :is(input, select, textarea)", "Add dark mode.")
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
    await type("[data-field=age] :is(input, select, textarea)", "42")
    await type("[data-field=count] :is(input, select, textarea)", "2")
    await submit()
    expect(root.querySelector("[data-error]")).toBeNull()
    expect((await store.list()).map(row => row.data)).toEqual([{ age: 42, count: 2, terms: false }])
  })

  it("submits the generated native controls with the same types as the hydrated form", async () => {
    const schema = v.object({
      age: v.number(),
      count: v.picklist([1, 2]),
      message: v.pipe(v.string(), v.trim()),
      terms: v.boolean(),
      extra: v.optional(v.number()),
      size: v.optional(v.picklist([1, 2])),
    })
    const { store, element, submit, type } = await mount(schema, schema)
    await type("[data-field=age] input", "42")
    await type("[data-field=count] select", "2")
    await type("[data-field=message] textarea", " Hello ")
    const form = element<HTMLFormElement>("form")
    // FormData reads the successful HTML controls without using the submit listener.
    const body = new URLSearchParams()
    for (const [key, value] of new FormData(form)) body.append(key, String(value))
    expect(Object.fromEntries(body)).toEqual({ age: "42", count: "2", message: " Hello ", extra: "", size: "", website: "" })
    expect(body.has("terms")).toBe(false)
    const response = await fetch(form.action, { method: "POST", headers: { accept: "text/html" }, body })
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/?form=contact.sent")
    await submit()
    expect((await store.list()).map(row => row.data)).toStrictEqual([
      { age: 42, count: 2, message: "Hello", terms: false },
      { age: 42, count: 2, message: "Hello", terms: false },
    ])
  })

  it("keeps the labels of two forms with one name apart", async () => {
    // One app with the form twice, such as in the footer and in a dialog.
    const root = document.createElement("div")
    document.body.append(root)
    createApp({ render: () => [h(AutoForm, { name: "contact", schema: ContactSchema }), h(AutoForm, { name: "contact", schema: ContactSchema })] }).mount(root)
    await nextTick()
    const inputs = [...root.querySelectorAll<HTMLInputElement>("[data-field=email] input")]
    expect(new Set(inputs.map(input => input.id)).size).toBe(2)
    expect(root.querySelector(`label[for="${inputs[1]!.id}"]`)?.textContent).toBe("Email")
  })

  it("lets an optional select go back to empty and reads metadata around v.optional()", async () => {
    const schema = v.object({
      size: v.optional(v.picklist(["s", "l"])),
      name: v.pipe(v.optional(v.string()), v.title("Your full name"), v.description("Use your legal name.")),
    })
    expect(describeFormFields(schema)[1]).toMatchObject({ label: "Your full name", description: "Use your legal name.", required: false })
    const { root } = await mount(schema, schema)
    expect(root.querySelector<HTMLOptionElement>("[data-field=size] option[value='']")?.disabled).toBe(false)
    expect(root.querySelector<HTMLOptionElement>("[data-field=topic] option[value='']")).toBeNull()
  })

  it("shows that it is busy while a slow check runs, and sends one message for two clicks", async () => {
    // The check waits until the test releases it, then passes at once, as the second validation of handleSubmit runs it again.
    let released = false
    const waiting: Array<() => void> = []
    const release = () => {
      released = true
      for (const resolve of waiting.splice(0)) resolve()
    }
    const slow = v.objectAsync({ message: v.pipeAsync(v.string(), v.checkAsync(async () => { if (!released) await new Promise<void>(resolve => waiting.push(resolve)); return true })) })
    const { root, store, type, element } = await mount(v.object({ message: v.string() }), slow as never)
    await type("[data-field=message] textarea", "Hello there")
    element<HTMLFormElement>("form").dispatchEvent(new Event("submit", { cancelable: true }))
    await nextTick()
    expect(root.querySelector("button")?.getAttribute("aria-busy")).toBe("true")
    element<HTMLFormElement>("form").dispatchEvent(new Event("submit", { cancelable: true }))
    release()
    await vi.waitFor(async () => expect(await store.list()).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await store.list()).toHaveLength(1)
  })

  it.each([false, true])("cancels a pending check when input changes (restored: %s)", async (restore) => {
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const check = vi.fn(async () => { await waiting; return true })
    const schema = v.objectAsync({ message: v.pipeAsync(v.string(), v.checkAsync(check)) })
    const { root, store, sent, type, element, submit } = await mount(v.object({ message: v.string() }), schema as never)
    await type("[data-field=message] textarea", "Clicked value")
    element<HTMLFormElement>("form").dispatchEvent(new Event("submit", { cancelable: true }))
    await vi.waitFor(() => expect(check).toHaveBeenCalled())
    await type("[data-field=message] textarea", "Edited after click")
    if (restore) await type("[data-field=message] textarea", "Clicked value")
    release()
    await vi.waitFor(() => expect(root.querySelector("button")?.hasAttribute("aria-busy")).toBe(false))
    expect(await store.list()).toEqual([])
    expect(sent).not.toHaveBeenCalled()
    // A fresh click may submit the current input.
    await submit()
    expect((await store.list()).map(row => row.data)).toEqual([{ message: restore ? "Clicked value" : "Edited after click" }])
  })

  it("removes the result through Vue Router when the app has one", async () => {
    history.replaceState(null, "", "/contact?plan=pro&form=contact.sent#top")
    try {
      const replace = vi.fn(async () => {})
      const root = document.createElement("div")
      document.body.append(root)
      const app = createApp(AutoForm, { name: "contact", schema: ContactSchema })
      // The router keeps its own copy of the address, so native history would come back on the next navigation.
      app.config.globalProperties.$router = { currentRoute: { value: { query: { plan: "pro", form: "contact.sent" }, hash: "#top" } }, isReady: async () => {}, replace }
      app.mount(root)
      await nextTick()
      expect(root.querySelector("[role=status]")?.textContent).toBe("Thanks. Your message was sent.")
      expect(replace).toHaveBeenCalledWith({ query: { plan: "pro" }, hash: "#top" })
      expect(location.search).toBe("?plan=pro&form=contact.sent")
    }
    finally {
      history.replaceState(null, "", "/")
    }
  })

  it("ignores the result of another form on the page", async () => {
    history.replaceState(null, "", "/contact?form=newsletter.sent")
    try {
      const { root } = await mount()
      expect(root.querySelector("[role=status]")?.textContent).toBe("")
      expect(location.search).toBe("?form=newsletter.sent")
    }
    finally {
      history.replaceState(null, "", "/")
    }
  })

  it("leaves focus in a field that the visitor chose before the app ran", async () => {
    history.replaceState(null, "", "/contact?form=contact.error")
    const field = document.createElement("input")
    document.body.append(field)
    field.focus()
    try {
      const { root } = await mount()
      expect(root.querySelector("[role=status]")?.textContent).toBe("The message was not sent. Check the form and try again.")
      expect(document.activeElement).toBe(field)
    }
    finally {
      field.remove()
      history.replaceState(null, "", "/")
    }
  })

  it("shows a schema check that throws as the form error", async () => {
    const schema = v.objectAsync({ message: v.pipeAsync(v.string(), v.checkAsync(async () => { throw new Error("The check is down.") })) })
    const { app, root, submit, type } = await mount(ContactSchema, schema as never)
    const errorHandler = vi.fn()
    app.config.errorHandler = errorHandler
    await type("[data-field=message] textarea", "Hello there")
    await submit()
    expect(root.querySelector("form > [role=alert]")?.textContent).toBe("The check is down.")
    expect(errorHandler).not.toHaveBeenCalled()
  })

  it("puts a server issue under its field", async () => {
    // The server is stricter than the client, as when a server rule changes first.
    const strict = v.object({ ...ContactSchema.entries, message: v.pipe(v.string(), v.minLength(50, "Tell us more on the server.")) })
    const { root, store, submit, type } = await mount(strict)
    await type("[data-field=email] :is(input, select, textarea)", "ada@example.com")
    await type("[data-field=topic] :is(input, select, textarea)", "bug")
    await type("[data-field=message] :is(input, select, textarea)", "Short but valid here.")
    // When focus arrives, the field already points to its error, so a screen reader reads it.
    const described: (string | null)[] = []
    root.querySelector("[data-field=message] textarea")!.addEventListener("focus", event => described.push((event.target as Element).getAttribute("aria-describedby")))
    await submit()
    expect(root.querySelector("[data-field=message] [data-error]")?.textContent).toBe("Tell us more on the server.")
    // Focus moves to the field, as with a client error.
    expect(document.activeElement).toBe(root.querySelector("[data-field=message] textarea"))
    expect(described.at(-1)).toContain("-error")
    expect(await store.list()).toEqual([])
  })
})
