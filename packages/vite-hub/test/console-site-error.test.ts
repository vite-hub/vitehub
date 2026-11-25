// @vitest-environment happy-dom
import type { HTMLButtonElement, HTMLInputElement, Window } from "happy-dom"
import { createApp, defineComponent, h } from "vue"
import type { Slots } from "vue"
import { afterEach, expect, it, vi } from "vitest"

import ConsoleSite from "../src/console/runtime/components/console-site.vue"

vi.mock("../src/console/runtime/client/project-session", () => ({
  useConsoleProjects: () => ({ mode: "account", current: { value: { id: "p-1", url: "https://app.example.com/portal" } }, info: { value: { operations: ["site.access"] } } }),
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
afterEach(() => { cleanup?.(); vi.unstubAllGlobals() })

function mountSite(fetch: (url: string, init: RequestInit) => Promise<Response>) {
  vi.stubGlobal("fetch", fetch)
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
  return { container, Event, tab }
}

const overview = { sessions: [], invites: [], grants: [{ id: "console", label: "Console", membersOnly: true }, { id: "comments-read", label: "Read comments" }] }

it("opens the app's /_vitehub/site in a new tab, which signs in through the Console", async () => {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => Response.json(overview))
  const { container, tab } = mountSite(fetch)
  const trigger = [...container.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === "Open site")!
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/projects/p-1/site", expect.objectContaining({ method: "GET" })))
  trigger.click()
  await vi.waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith("https://app.example.com/portal/_vitehub/site?return=%2F&project=p-1"))
})

it("shows the roles of the last token of a member browser", async () => {
  const session = { id: "s-1", kind: "member", person: { id: "u-1", name: "Ada" }, grants: ["console", "comments-read"], device: "Phone", createdAt: "2026-11-23T00:00:00.000Z", lastSeenAt: "2026-11-23T00:00:00.000Z", expiresAt: "2026-11-30T00:00:00.000Z" }
  const { container } = mountSite(async () => Response.json({ ...overview, sessions: [session] }))
  await vi.waitFor(() => expect(container.textContent).toContain("Phone · Console, Read comments"))
  expect(container.textContent).not.toContain("every page tool")
})

it.each([
  { action: "Link a phone", path: "/api/projects/p-1/site/codes", payload: {}, scope: "main" },
  { action: "Invite someone", path: "/api/projects/p-1/site/invites", payload: { name: "Ana", grants: ["comments-read"], expiresInDays: 7 }, scope: "[role=dialog]" },
])("shows why the Console refused $action", async ({ action, path, payload, scope }) => {
  const message = "Only members of the team open the site from the Console."
  const fetch = vi.fn(async (url: string, init: RequestInit) => init.method === "GET"
    ? Response.json(overview)
    : Response.json({ code: "CONSOLE_SITE_FORBIDDEN", message, ok: false, status: 403 }, { status: 403 }))
  const { container, Event, tab } = mountSite(fetch)
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
  expect(diagnostic()).toContain("CONSOLE_SITE_FORBIDDEN")
  const sent = fetch.mock.calls.find(([url]) => url === path)!
  expect([sent[1].method, JSON.parse(String(sent[1].body))]).toEqual(["POST", payload])
  expect(tab.location.replace).not.toHaveBeenCalled()
  if (action !== "Invite someone") expect(container.querySelector("[role=dialog]")).toBeNull()
  expect(container.querySelector("[aria-label='Invite link']")).toBeNull()
})
