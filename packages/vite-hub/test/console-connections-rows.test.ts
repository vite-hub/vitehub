// @vitest-environment happy-dom
import type { Window } from "happy-dom"
import { createApp, defineComponent, h, nextTick, type Component, type PropType, type Slot } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ConnectionInspection } from "@vite-hub/connections"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/connections-management", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/connections-management")>(),
  requestConnectionsManagement: mocks.request,
}))
vi.mock("../src/console/runtime/components/console-frame.vue", async () => {
  const { defineComponent } = await import("vue")
  return { default: defineComponent({ setup: (_props, { slots }) => () => slots.default?.() }) }
})
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: { render: () => null } }))
vi.mock("../src/console/runtime/components/console-connections-details.vue", async () => {
  const { defineComponent, h } = await import("vue")
  return {
    default: defineComponent({
      props: { connection: Object, endpoint: String, initialTab: String, keyForm: Boolean, returnTo: String },
      setup: props => () => h("div", {
        "data-details": props.connection && "name" in props.connection ? String(props.connection.name) : "",
        "data-key-form": String(props.keyForm),
        "data-tab": props.initialTab,
      }),
    }),
  }
})

import Connections from "../src/console/runtime/components/console-connections.vue"

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
  props: { ariaLabel: String, label: String, onClick: Function, target: String, to: String },
  setup(props) {
    return () => props.to
      ? h("a", { "aria-label": props.ariaLabel, "data-button": props.label, href: props.to, target: props.target }, props.label)
      : h("button", { "aria-label": props.ariaLabel, "data-button": props.label, onClick: props.onClick, type: "button" }, props.label)
  },
})
const UBadge = defineComponent({ props: { color: String, label: String }, setup: props => () => h("span", { "data-badge": props.color }, props.label) })
const Passthrough = defineComponent({ setup: (_props, { slots }) => () => slots.default?.() })
interface Column { id?: string, accessorKey?: string }
const UTable = defineComponent({
  props: { columns: { type: Array as PropType<Column[]>, required: true }, data: { type: Array as PropType<ConnectionInspection[]>, required: true }, empty: String },
  setup(props, { slots }) {
    return () => h("table", h("tbody", props.data.map(original => h("tr", { "data-row": original.name }, props.columns.map((column) => {
      const slot: Slot | undefined = slots[`${column.id ?? column.accessorKey}-cell`]
      return h("td", { "data-column": column.id ?? column.accessorKey }, slot?.({ row: { original } }))
    })))))
  },
})
const UDashboardPanel = defineComponent({ setup: (_props, { slots }) => () => h("div", [slots.header?.(), slots.body?.()]) })
const USlideover = defineComponent({
  props: { open: Boolean },
  setup: (props, { slots }) => () => props.open ? h("aside", slots.body?.()) : null,
})

const connection = (overrides: Partial<ConnectionInspection> & Pick<ConnectionInspection, "name">): ConnectionInspection => ({
  actions: [],
  credential: "oauth2",
  provider: overrides.name,
  scopes: { declared: [], granted: [], missing: [] },
  status: "disconnected",
  ...overrides,
})

async function render(connections: ConnectionInspection[], counts: Record<string, number> = {}) {
  mocks.request.mockReset().mockImplementation(async (_endpoint: string, action: string) =>
    action === "list" ? { connections } : { counts },
  )
  const root = page().document.createElement("div")
  page().document.body.append(root)
  const app = createApp(Connections as Component, {
    agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv",
    managementBase: "/_vitehub/connections", searchBase: "/search", sectionsBase: "/sections",
  })
  app.component("UButton", UButton).component("UBadge", UBadge).component("UIcon", Passthrough)
    .component("UTooltip", Passthrough).component("UInput", Passthrough).component("UDashboardNavbar", Passthrough)
    .component("UDashboardPanel", UDashboardPanel).component("UTable", UTable).component("USlideover", USlideover)
  app.mount(root)
  await vi.waitFor(() => expect(root.querySelector("[role=status]")?.textContent ?? "").not.toContain("Loading"))
  await nextTick()
  const row = (name: string) => {
    const element = root.querySelector(`[data-row="${name}"]`)
    if (!element) throw new Error(`Expected a row for ${name}`)
    return {
      actions: [...element.querySelectorAll("[data-column=action] [data-button]")].map(button => button.getAttribute("data-button")),
      badges: [...element.querySelectorAll("[data-badge]")].map(badge => `${badge.getAttribute("data-badge")}:${badge.textContent}`),
      element,
      text: (column: string) => element.querySelector(`[data-column=${column}]`)?.textContent ?? "",
    }
  }
  return { app, root, row }
}

describe("Console Connections rows", () => {
  let unmount: (() => void) | undefined
  beforeEach(() => page().history.replaceState(null, "", "/_vitehub/connections"))
  afterEach(() => {
    unmount?.()
    unmount = undefined
    page().document.body.replaceChildren()
  })

  it("shows one visible next step for each status and credential type", async () => {
    const { app, row } = await render([
      connection({ name: "drop", account: { id: "github-22072217" }, status: "connected" }),
      connection({ name: "support-inbox", provider: "google" }),
      connection({ name: "calendar", provider: "google", status: "reauth_required" }),
      connection({ name: "gmail", provider: "google", status: "connected", scopes: { declared: ["a", "b"], granted: ["a"], missing: ["b"] } }),
      connection({ name: "old", status: "revoked" }),
      connection({ name: "posthog", credential: "api-key" }),
      connection({ name: "executor", credential: "api-key", status: "connected" }),
      connection({ name: "crm", credential: "api-key", status: "reauth_required" }),
    ])
    unmount = () => app.unmount()

    expect(row("drop").actions).toEqual([])
    expect(row("drop").badges).toEqual(["success:Connected"])
    expect(row("drop").text("account")).toBe("github-22072217")
    expect(row("drop").text("credential")).toBe("OAuth")

    expect(row("support-inbox").actions).toEqual(["Connect"])
    expect(row("support-inbox").badges).toEqual(["neutral:Not connected"])
    expect(row("support-inbox").text("name")).toBe("support-inboxgoogle")
    expect(row("calendar").actions).toEqual(["Reconnect"])
    expect(row("calendar").badges).toEqual(["error:Reconnect required"])
    expect(row("gmail").actions).toEqual(["Reconnect"])
    expect(row("gmail").badges).toEqual(["success:Connected", "warning:1 missing scope"])
    expect(row("old").actions).toEqual(["Connect"])

    expect(row("posthog").actions).toEqual(["Set key"])
    expect(row("posthog").text("credential")).toBe("API key")
    expect(row("posthog").text("name")).toBe("posthog")
    expect(row("executor").actions).toEqual([])
    expect(row("crm").actions).toEqual(["Replace key"])
  })

  it("connects OAuth in the same tab and returns to this page", async () => {
    const { app, row } = await render([connection({ name: "team/mail" })])
    unmount = () => app.unmount()
    const link = row("team/mail").element.querySelector("a[data-button=Connect]")
    expect(link?.getAttribute("href")).toBe("/_vitehub/connections/connect/team%2Fmail?return=%2F_vitehub%2Fconnections")
    expect(link?.getAttribute("target")).toBeNull()
    expect(link?.getAttribute("aria-label")).toBe("Connect team/mail")
  })

  it("opens the details panel at the key field from Set key", async () => {
    const { app, root, row } = await render([connection({ name: "posthog", credential: "api-key" })])
    unmount = () => app.unmount()
    const button = row("posthog").element.querySelector("button[data-button='Set key']")
    expect(button?.getAttribute("aria-label")).toBe("Set key for posthog")
    button?.dispatchEvent(new (page().MouseEvent)("click"))
    await nextTick()
    const details = root.querySelector("[data-details]")
    expect(details?.getAttribute("data-details")).toBe("posthog")
    expect(details?.getAttribute("data-key-form")).toBe("true")
    expect(details?.getAttribute("data-tab")).toBe("details")
  })

  it("shows missing scopes and pending approvals only when they exist", async () => {
    const { app, root, row } = await render([
      connection({ name: "drop", account: { id: "github-22072217" }, status: "connected" }),
      connection({ name: "posthog", credential: "api-key" }),
      connection({ name: "gmail", status: "connected", account: { email: "ada@example.com", id: "1" } }),
    ], { drop: 0, gmail: 2, posthog: 0 })
    unmount = () => app.unmount()
    expect(root.querySelector("table")?.textContent).not.toMatch(/None|\b0\b/)
    expect(row("posthog").text("account")).toBe("")
    const review = row("gmail").element.querySelector("[data-button='2 pending approvals']")
    expect(review?.getAttribute("aria-label")).toBe("Review 2 pending approvals for gmail")
    review?.dispatchEvent(new (page().MouseEvent)("click"))
    await nextTick()
    expect(root.querySelector("[data-details]")?.getAttribute("data-tab")).toBe("approvals")
  })

  it("explains that Connections come from code", async () => {
    const listed = await render([connection({ name: "drop" })])
    try {
      const hint = listed.root.querySelector("a[href='https://vitehub.dev/docs/connections/get-started']")
      expect(hint?.textContent).toContain("Add a Connection")
      expect(hint?.closest("p")?.textContent).toContain("Defined in server/connections/")
    }
    finally { listed.app.unmount() }
    page().document.body.replaceChildren()

    const empty = await render([])
    unmount = () => empty.app.unmount()
    const state = empty.root.querySelector("[role=status]")
    expect(state?.textContent).toContain("No Connections yet")
    expect(state?.textContent).toContain("Connections are defined in code.")
    expect(state?.querySelector("pre")?.textContent).toContain("// server/connections/crm.ts")
    expect(state?.querySelector("pre")?.textContent).toContain("defineConnection({")
    expect(state?.querySelector("[data-button='Get started']")?.getAttribute("href")).toBe("https://vitehub.dev/docs/connections/get-started")
  })
})
