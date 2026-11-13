// @vitest-environment happy-dom
// The N4 check: one schema renders as a web form, an MCP elicitation, a Slack modal, and a Teams dialog, and the
// same values give the same errors on every surface.
import { createHmac } from "node:crypto"

import { createSlackAdapter } from "@chat-adapter/slack"
import { modalToAdaptiveCard, parseTeamsDialogSubmitValues } from "@chat-adapter/teams/modals"
import * as v from "valibot"
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick } from "vue"
import { z } from "zod"

import { fieldErrors } from "../src/client.ts"
import { chatModalErrors, createMemoryFormsStore, defineForm, formFields, handleFormRequest, readChatModal, readElicitation, toChatModal, toElicitation } from "../src/index.ts"
import { useFormAction } from "../src/vue.ts"

import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { ChatInstance, ModalElement, ModalResponse, ModalSubmitEvent } from "chat"
import type { FormDefinition, FormField } from "../src/index.ts"

const ValibotFeedback = v.object({
  email: v.pipe(v.string(), v.email("Enter a valid email.")),
  topic: v.picklist(["bug", "idea"]),
  rating: v.pipe(v.number(), v.integer(), v.minValue(1, "Pick 1 to 5."), v.maxValue(5, "Pick 1 to 5.")),
  message: v.pipe(v.string(), v.title("Your message"), v.minLength(5, "Write a little more.")),
  followUp: v.optional(v.boolean()),
})

// An Agent tool input is a plain Standard Schema with a Standard JSON Schema, such as a Zod object.
const ZodFeedback = z.object({
  email: z.email("Enter a valid email."),
  topic: z.enum(["bug", "idea"]),
  rating: z.number().int().min(1, "Pick 1 to 5.").max(5, "Pick 1 to 5."),
  message: z.string().min(5, "Write a little more.").meta({ title: "Your message" }),
  followUp: z.boolean().optional(),
})

type Values = { email: string, topic: string, rating: number, message: string, followUp: boolean }

const valid: Values = { email: "ada@example.com", topic: "bug", rating: 4, message: "Works well", followUp: true }
const cases: [string, Values, Record<string, string>][] = [
  ["valid values", valid, {}],
  ["one bad field", { ...valid, email: "ada" }, { email: "Enter a valid email." }],
  ["two bad fields", { ...valid, email: "ada", rating: 9 }, { email: "Enter a valid email.", rating: "Pick 1 to 5." }],
]

/** A surface takes values the way a person enters them there, and returns the error of each field, or the stored data. */
type Surface = (form: FormDefinition, values: Values) => Promise<{ errors: Record<string, string>, data?: unknown, payload: unknown }>

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.unstubAllGlobals()
})

async function settle() {
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
}

// A native <form> drawn from the same fields, sent with useFormAction() to handleFormRequest().
const web: Surface = async (form, values) => {
  const store = createMemoryFormsStore()
  const bodies: string[] = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(input), location.origin), init)
    bodies.push(await request.clone().text())
    return handleFormRequest("feedback", form, request, { store })
  })
  const control = (field: FormField) => {
    if (field.type === "boolean") return h("input", { type: "checkbox", name: field.name })
    if (field.options) return h("select", { name: field.name }, [h("option", { value: "" }, "Choose one"), ...field.options.map(option => h("option", { value: String(option) }, String(option)))])
    return h("input", { type: field.type === "string" ? "text" : "number", name: field.name })
  }
  let state: ReturnType<typeof useFormAction> | undefined
  const app = createApp(defineComponent({
    setup() {
      state = useFormAction("feedback")
      const { submit, errors } = state
      return () => h("form", { onSubmit: submit }, [
        ...formFields(form).map(field => h("label", { "data-field": field.name }, [field.label, control(field), errors.value[field.name] ? h("span", { "data-error": "" }, errors.value[field.name]) : null])),
        h("button", { type: "submit" }, "Send"),
      ])
    },
  }))
  const host = document.body.appendChild(document.createElement("div"))
  app.mount(host)
  cleanup = () => {
    app.unmount()
    host.remove()
  }
  for (const [name, value] of Object.entries(values)) {
    const element = host.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)!
    if (element instanceof HTMLInputElement && element.type === "checkbox") element.checked = value === true
    else element.value = String(value)
  }
  host.querySelector("form")!.requestSubmit()
  await vi.waitFor(async () => {
    await settle()
    if (state?.pending.value) throw new Error("still sending")
  })
  await settle()
  const errors = Object.fromEntries([...host.querySelectorAll("[data-field]")].flatMap(label => {
    const message = label.querySelector("[data-error]")?.textContent
    return message ? [[label.getAttribute("data-field")!, message]] : []
  }))
  return { errors, data: (await store.list())[0]?.data, payload: bodies[0] }
}

// The MCP client shows `requestedSchema`, and answers `{ action: "accept", content }`.
const mcp: Surface = async (form, values) => {
  const request = toElicitation(form, { message: "Tell us how it went." })
  const [error, result] = await readElicitation(form, { action: "accept", content: values })
  return { errors: fieldErrors(error), data: result?.action === "accept" ? result.data : undefined, payload: request }
}

function slackSignature(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`
}

type SlackBlock = { type: string, block_id?: string, element?: { type: string, action_id: string } }

/** A ChatInstance that hands a modal submission to the app's `onModalSubmit()` handler, as `new Chat()` does. */
function chatWith(handler: (event: ModalSubmitEvent) => Promise<ModalResponse | undefined>): ChatInstance {
  // SAFETY: the Slack adapter calls only `processModalSubmit()` for a view submission.
  return { processModalSubmit: (event: ModalSubmitEvent) => handler(event) } as unknown as ChatInstance
}

// The Chat SDK Slack adapter: `views.open` with the modal, then a signed `view_submission` webhook.
const slack: Surface = async (form, values) => {
  const signingSecret = "test-secret"
  const adapter = createSlackAdapter({ botToken: "xoxb-test", signingSecret })
  const opened: { view: { blocks: SlackBlock[] } }[] = []
  Reflect.set(adapter, "_client", { auth: { test: async () => ({ ok: true, user_id: "UBOT" }) }, views: { open: async (args: { view: { blocks: SlackBlock[] } }) => { opened.push(args); return { ok: true, view: { id: "V1" } } } } })
  let data: unknown
  await adapter.initialize(chatWith(async (event) => {
    const [error, output] = await readChatModal(form, event.values)
    if (error) return chatModalErrors(error)
    data = output
    return undefined
  }))
  await adapter.openModal("trigger-1", toChatModal(form, { callbackId: "feedback", title: "Feedback" }))
  const view = opened[0]!.view
  const state: Record<string, Record<string, unknown>> = {}
  for (const block of view.blocks) {
    if (block.type !== "input" || !block.element || !block.block_id) continue
    const value = String(values[block.block_id as keyof Values])
    const { type, action_id } = block.element
    state[block.block_id] = { [action_id]: type === "static_select" || type === "radio_buttons" ? { type, selected_option: { value } } : { type, value } }
  }
  const payload = { type: "view_submission", user: { id: "U1", name: "ada" }, view: { id: "V1", callback_id: "feedback", state: { values: state } } }
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
  const timestamp = String(Math.floor(Date.now() / 1000))
  const response = await adapter.handleWebhook(new Request("https://app.test/api/slack", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": timestamp, "x-slack-signature": slackSignature(signingSecret, timestamp, body) },
    body,
  }))
  const text = await response.text()
  const answer: { response_action?: string, errors?: Record<string, string> } = text ? JSON.parse(text) : {}
  if (answer.response_action !== undefined) expect(answer.response_action).toBe("errors")
  return { errors: answer.errors ?? {}, data, payload: view }
}

// The Chat SDK Teams adapter draws the same modal as an Adaptive Card dialog, and parses its submit data.
const teams: Surface = async (form, values) => {
  const card = modalToAdaptiveCard(toChatModal(form, { callbackId: "feedback", title: "Feedback" }))
  const submitted = parseTeamsDialogSubmitValues({ __callbackId: "feedback", ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])) })
  const [error, output] = await readChatModal(form, submitted.values)
  return { errors: error ? chatModalErrors(error).errors : {}, data: output, payload: card }
}

const surfaces = { web, mcp, slack, teams }
const schemas: [string, StandardSchemaV1][] = [["Valibot defineForm()", ValibotFeedback], ["Zod tool input", ZodFeedback]]

describe.each(schemas)("one %s schema", (_label, schema) => {
  const form = defineForm({ schema })
  describe.each(Object.entries(surfaces))("on %s", (_surface, surface) => {
    it.each(cases)("gives the same errors for %s", async (_case, values, expected) => {
      const { errors, data } = await surface(form, values)
      expect(errors).toEqual(expected)
      if (!Object.keys(expected).length) expect(data).toEqual(values)
    })
  })
})

describe("the payload of each surface", () => {
  const form = defineForm({ schema: ValibotFeedback })
  it.each(Object.entries(surfaces))("%s", async (_surface, surface) => {
    expect((await surface(form, valid)).payload).toMatchSnapshot()
  })

  it("is a Chat SDK modal, and an MCP form elicitation of primitive properties", () => {
    expectTypeOf(toChatModal(form, { callbackId: "feedback", title: "Feedback" })).toExtend<ModalElement>()
    const { requestedSchema } = toElicitation(form, { message: "Tell us how it went." })
    for (const property of Object.values(requestedSchema.properties)) expect(["string", "number", "integer", "boolean"]).toContain(property.type)
  })
})

describe("a schema outside the shared subset", () => {
  it.each([
    ["a nested object", v.object({ address: v.object({ city: v.string() }) })],
    ["a list", v.object({ tags: v.array(v.string()) })],
    ["a root that is not an object", v.string()],
    ["a nested Zod object", z.object({ address: z.object({ city: z.string() }) })],
  ])("fails with FORMS_C0002 on every surface: %s", (_label, schema) => {
    const form = defineForm({ schema })
    expect(() => formFields(form)).toThrow(expect.objectContaining({ code: "FORMS_C0002" }))
    expect(() => toElicitation(form, { message: "?" })).toThrow(expect.objectContaining({ code: "FORMS_C0002" }))
    expect(() => toChatModal(form, { callbackId: "x", title: "X" })).toThrow(expect.objectContaining({ code: "FORMS_C0002" }))
  })

  it("fails with FORMS_C0002 only in MCP for a choice of numbers, which MCP enums cannot hold", () => {
    const form = defineForm({ schema: v.object({ size: v.picklist([1, 2]) }) })
    expect(() => toElicitation(form, { message: "?" })).toThrow(expect.objectContaining({ code: "FORMS_C0002" }))
    expect(toChatModal(form, { callbackId: "size", title: "Size" }).children).toHaveLength(1)
  })
})
