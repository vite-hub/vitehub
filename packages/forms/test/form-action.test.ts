// @vitest-environment happy-dom
import { Field, FieldError, FieldLabel } from "@ui-sdk/vue/field"
import { Input } from "@ui-sdk/vue/input"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick } from "vue"

import { createMemoryFormsStore, defineForm, handleFormRequest } from "../src/index.ts"
import { formRoute, useFormAction } from "../src/vue.ts"

import type { FormsStore } from "../src/index.ts"

const Contact = v.object({
  email: v.pipe(v.string(), v.email("Enter a valid email.")),
  seats: v.pipe(v.number(), v.maxValue(10, "Ten seats at most.")),
  message: v.pipe(v.string(), v.minLength(5, "Write a little more.")),
})

// The usage of ui-sdk: a native <form>, and a Field with an Input for each control, matched by `name`.
const ContactForm = defineComponent({
  setup() {
    const { submit, errors, sent, error, pending, clear } = useFormAction("contact")
    const field = (name: string, label: string, type: string) => h(Field, { name, invalid: errors.value[name] ? true : undefined }, () => [
      h(FieldLabel, null, () => label),
      h(Input, { type, onValueChange: () => clear(name) }),
      errors.value[name] ? h(FieldError, { match: true }, () => errors.value[name]) : null,
    ])
    return () => h("form", { method: "post", action: formRoute("contact"), onSubmit: submit }, [
      field("email", "Email", "text"),
      field("seats", "Seats", "number"),
      field("message", "Message", "text"),
      h("p", { role: "status" }, sent.value ? "Sent." : error.value && !Object.keys(errors.value).length ? error.value.message : ""),
      h("button", { type: "submit", "aria-busy": pending.value ? "true" : undefined }, "Send"),
    ])
  },
})

let unmount: (() => void) | undefined
afterEach(() => {
  unmount?.()
  vi.unstubAllGlobals()
})

async function settle() {
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
}

function mount(store: FormsStore = createMemoryFormsStore()) {
  const requests: Request[] = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(input), location.origin), init)
    requests.push(request.clone())
    return handleFormRequest("contact", defineForm({ schema: Contact }), request, { store })
  })
  const host = document.body.appendChild(document.createElement("div"))
  const app = createApp(ContactForm)
  app.mount(host)
  unmount = () => {
    app.unmount()
    host.remove()
  }
  const input = (name: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!
  const fill = async (values: Record<string, string>) => {
    for (const [name, value] of Object.entries(values)) {
      // The prototype setter, as typing does: ui-sdk reads a write through the instance as a change by code.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(name), value)
      input(name).dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }))
    }
    await settle()
  }
  const submit = async () => {
    host.querySelector("form")!.requestSubmit()
    await vi.waitFor(async () => {
      await settle()
      if (host.querySelector("button")?.hasAttribute("aria-busy")) throw new Error("still sending")
    })
    await settle()
  }
  const error = (name: string) => input(name).closest("[data-slot=field]")?.querySelector("[data-slot=field-error]")?.textContent ?? null
  return { host, input, fill, submit, error, requests, store }
}

describe("useFormAction", () => {
  it("shows each server error in the Field with the same name and focuses the first one", async () => {
    const { input, fill, submit, error } = mount()
    await fill({ email: "ada@example.com", seats: "12", message: "Hi" })
    await submit()
    expect(error("email")).toBeNull()
    expect(error("seats")).toBe("Ten seats at most.")
    expect(error("message")).toBe("Write a little more.")
    expect(input("seats").getAttribute("aria-invalid")).toBe("true")
    // The error describes its control, so focus reads it.
    expect(input("seats").getAttribute("aria-describedby")).toContain(input("seats").closest("[data-slot=field]")!.querySelector("[data-slot=field-error]")!.id)
    // The first field with an error in page order, not in the order of the issues.
    expect(document.activeElement).toBe(input("seats"))
  })

  it("clears the error of a field when the person edits it", async () => {
    const { input, fill, submit, error } = mount()
    await fill({ email: "ada@example.com", seats: "12", message: "Hi" })
    await submit()
    await fill({ seats: "3" })
    expect(error("seats")).toBeNull()
    expect(input("seats").hasAttribute("aria-invalid")).toBe(false)
    expect(error("message")).toBe("Write a little more.")
  })

  it("sends the controls as form data, so the server decodes them to the schema types, and resets after a success", async () => {
    const { host, input, fill, submit, requests, store } = mount()
    await fill({ email: "ada@example.com", seats: "3", message: "Hello there" })
    await submit()
    expect(requests[0]!.headers.get("content-type")).toBe("application/x-www-form-urlencoded")
    expect((await store.list())[0]?.data).toEqual({ email: "ada@example.com", seats: 3, message: "Hello there" })
    expect(host.querySelector("[role=status]")?.textContent).toBe("Sent.")
    expect(input("email").value).toBe("")
  })

  it("sends once while a send is pending", async () => {
    const { host, fill, submit, requests } = mount()
    await fill({ email: "ada@example.com", seats: "3", message: "Hello there" })
    host.querySelector("form")!.requestSubmit()
    await submit()
    expect(requests).toHaveLength(1)
  })
})
