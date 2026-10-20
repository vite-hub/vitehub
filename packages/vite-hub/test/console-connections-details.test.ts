// @vitest-environment happy-dom
import type { Window } from "happy-dom"
import { createApp, defineComponent, h, type Component } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ConnectionInspection } from "@vite-hub/connections"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/connections-management", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/connections-management")>(),
  requestConnectionsManagement: mocks.request,
}))
vi.mock("../src/console/runtime/components/console-connections-activity.vue", () => ({ default: { render: () => null } }))
vi.mock("../src/console/runtime/components/console-connections-approvals.vue", async () => {
  const { h } = await import("vue")
  return { default: { render: () => h("div", { "data-approvals": "" }) } }
})

import Details from "../src/console/runtime/components/console-connections-details.vue"

type TestPage = Pick<Window, "document" | "history" | "MouseEvent">

function isTestPage(value: unknown): value is TestPage {
  return value instanceof Object && "document" in value && "history" in value && "MouseEvent" in value
}

/** The happy-dom globals of this test environment. The Console reads their location. */
function page(): TestPage {
  const value: unknown = globalThis
  if (!isTestPage(value)) throw new TypeError("Expected the happy-dom test environment.")
  return value
}

const UButton = defineComponent({
  inheritAttrs: false,
  props: { label: String, onClick: Function, to: String },
  setup(props) {
    return () => props.to
      ? h("a", { "data-button": props.label, href: props.to }, props.label)
      : h("button", { "data-button": props.label, onClick: props.onClick, type: "button" }, props.label)
  },
})
const UInput = defineComponent({
  props: { autofocus: Boolean, type: String },
  setup: props => () => h("input", { "data-autofocus": String(props.autofocus), type: props.type }),
})
const Passthrough = defineComponent({ setup: (_props, { slots }) => () => slots.default?.() })

const connection = (overrides: Partial<ConnectionInspection>): ConnectionInspection => ({
  actions: [],
  credential: "oauth2",
  name: "mail",
  provider: "google",
  scopes: { declared: [], granted: [], missing: [] },
  status: "disconnected",
  ...overrides,
})

const mounted: Array<() => void> = []
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
  page().document.body.replaceChildren()
})

async function render(props: Record<string, unknown>, inspected: ConnectionInspection) {
  mocks.request.mockReset().mockResolvedValue({ connection: inspected })
  const root = page().document.createElement("div")
  page().document.body.append(root)
  const app = createApp(Details as Component, { endpoint: "/_vitehub/connections", ...props })
  app.component("UButton", UButton).component("UInput", UInput).component("UBadge", Passthrough)
    .component("UFormField", Passthrough).component("UIcon", Passthrough).component("UTooltip", Passthrough)
  app.mount(root)
  mounted.push(() => app.unmount())
  await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledWith("/_vitehub/connections", "inspect", expect.anything(), { name: inspected.name }))
  await new Promise(resolve => setTimeout(resolve))
  return root
}

describe("Console Connection details", () => {
  it("opens the key field after the row action Set key", async () => {
    const key = connection({ credential: "api-key", name: "posthog", provider: "posthog" })
    const root = await render({ connection: key, keyForm: true }, key)
    const input = root.querySelector("input[type=password]")
    expect(input?.getAttribute("data-autofocus")).toBe("true")
    expect(root.textContent).toContain("API key")
  })

  it("keeps the key form closed without the row action", async () => {
    const key = connection({ credential: "api-key", name: "posthog", provider: "posthog" })
    const root = await render({ connection: key }, key)
    expect(root.querySelector("input[type=password]")).toBeNull()
    expect(root.querySelector("[data-button='Set key']")).not.toBeNull()
  })

  it("connects OAuth in the same tab and returns to the Console page", async () => {
    const oauth = connection({})
    const root = await render({ connection: oauth, returnTo: "/portal/_vitehub/connections" }, oauth)
    expect(root.querySelector("[data-button=Connect]")?.getAttribute("href"))
      .toBe("/_vitehub/connections/connect/mail?return=%2Fportal%2F_vitehub%2Fconnections")
    expect(root.textContent).toContain("OAuth")
  })

  it("opens at the tab that the row asked for", async () => {
    const oauth = connection({ status: "connected" })
    const root = await render({ connection: oauth, initialTab: "approvals" }, oauth)
    expect(root.querySelector("[data-approvals]")).not.toBeNull()
  })
})
