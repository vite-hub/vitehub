// @vitest-environment happy-dom
import type { HTMLButtonElement, HTMLInputElement, Window } from "happy-dom"
import { createApp, defineComponent, h } from "vue"
import type { Slots } from "vue"
import { afterEach, expect, it, vi } from "vitest"

import { ConsoleRequestError } from "../src/console/runtime/client/request"
import ConsoleSite from "../src/console/runtime/components/console-site.vue"

const request = vi.hoisted(() => vi.fn())
vi.mock("../src/console/runtime/client/request", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/request")>(),
  requestConsoleOperation: request,
}))
vi.mock("../src/console/runtime/components/console-confirm.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-page-header.vue", () => ({ default: {
  setup: (_props: unknown, { slots }: { slots: Slots }) => () => h("header", slots.right?.()),
} }))

const passthrough = defineComponent({ setup: (_props, { slots }) => () => h("div", slots.default?.()) })
const button = defineComponent({
  props: { label: String },
  setup: (props, { slots }) => () => h("button", props.label ?? slots.default?.()),
})
const alert = defineComponent({
  props: { title: String },
  setup: (props, { slots }) => () => h("div", [props.title, slots.description?.(), slots.actions?.()]),
})
const modal = defineComponent({
  props: { open: Boolean },
  setup: (props, { slots }) => () => props.open ? h("div", { role: "dialog" }, [slots.body?.(), slots.footer?.()]) : null,
})
const input = defineComponent({
  props: { modelValue: String },
  emits: ["update:modelValue"],
  setup: (props, { emit }) => () => h("input", { value: props.modelValue, onInput: (event: { target: { value: string } }) => emit("update:modelValue", event.target.value) }),
})

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); request.mockReset(); vi.unstubAllGlobals() })

it.each([
  { action: "Open site", operation: "site.link", payload: {}, scope: "main" },
  { action: "Link a phone", operation: "site.link", payload: { qr: true }, scope: "main" },
  { action: "Invite someone", operation: "site.invite", payload: { name: "Ana", grants: ["comments-read"], expiresInDays: 7 }, scope: "[role=dialog]" },
])("shows the Auth setup guidance for $action", async ({ action, operation, payload, scope }) => {
  const message = "Auth's user.role field can be set by the user."
  const fix = "Set input: false on the field."
  request.mockImplementation(async (name: string) => {
    if (name === "site.invites") return { invites: [] }
    if (name === "site.grants") return { grants: [{ id: "comments-read", label: "Read comments" }] }
    if (name === "site.sessions") throw new ConsoleRequestError(409, { code: "AUTH_CONSOLE_UNAVAILABLE", message: "Auth could not list site browsers.", fix })
    throw new ConsoleRequestError(409, { code: "AUTH_CONSOLE_UNAVAILABLE", message, fix })
  })
  const tab = { close: vi.fn(), location: { replace: vi.fn() }, opener: null }
  vi.stubGlobal("open", () => tab)
  const app = createApp(ConsoleSite, { agentsBase: "", definitionsBase: "", kvBase: "", searchBase: "", sectionsBase: "" })
  for (const name of ["UCheckbox", "UDashboardPanel", "UEmpty", "UFormField", "URadioGroup", "USkeleton", "UTooltip"]) app.component(name, passthrough)
  app.component("UAlert", alert)
  app.component("UButton", button)
  app.component("UInput", input)
  app.component("UModal", modal)
  const { document, Event } = globalThis as unknown as Pick<Window, "document" | "Event">
  const container = document.createElement("div")
  document.body.append(container)
  cleanup = () => { app.unmount(); container.remove() }
  app.mount(container)

  await vi.waitFor(() => expect(container.querySelector("main [role=alert]")?.textContent).toContain("Auth could not list site browsers."))
  const trigger = [...container.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === action)!
  await vi.waitFor(() => expect(trigger.disabled).toBe(false))
  trigger.click()
  if (action === "Invite someone") {
    await vi.waitFor(() => expect(container.querySelector("#site-invite input")).not.toBeNull())
    const name = container.querySelector<HTMLInputElement>("#site-invite input")!
    name.value = "Ana"
    name.dispatchEvent(new Event("input"))
    container.querySelector("#site-invite")!.dispatchEvent(new Event("submit", { cancelable: true }))
  }

  const diagnostic = () => container.querySelector(`${scope} [role=alert]`)?.textContent
  await vi.waitFor(() => expect(diagnostic()).toContain(message))
  expect(diagnostic()).toContain(fix)
  expect(diagnostic()).toContain("AUTH_CONSOLE_UNAVAILABLE")
  expect(request).toHaveBeenCalledWith(operation, payload)
  expect(tab.location.replace).not.toHaveBeenCalled()
  if (action === "Open site") expect(tab.close).toHaveBeenCalledOnce()
  if (action !== "Invite someone") expect(container.querySelector("[role=dialog]")).toBeNull()
  expect(container.querySelector("[aria-label='Invite link']")).toBeNull()
})
