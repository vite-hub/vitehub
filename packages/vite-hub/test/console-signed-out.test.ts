// @vitest-environment happy-dom
import { Window } from "happy-dom"
import { createApp, defineComponent, h, ref, type Component } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), requestConsole: vi.fn() }))
vi.mock("@nuxt/ui/composables", () => ({ defineShortcuts: vi.fn() }))
vi.mock("@vite-hub/auth/vue", () => ({ createAuthClient: () => ({ getSession: mocks.getSession }) }))
vi.mock("vite-hub/source/client", () => ({
  useCollection: () => ({ error: ref(), items: ref([]), pending: ref(false), refresh: vi.fn() }),
}))
vi.mock("vue-router", () => ({
  useRoute: () => ({ name: "vitehub-console", params: {} }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock("../src/console/runtime/client/request", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/request")>(),
  requestConsole: mocks.requestConsole,
}))
// The Overview test renders the page without its rail and search. The rail has a test of its own below.
vi.mock("../src/console/runtime/components/console-frame.vue", () => ({
  default: defineComponent({ setup: (_props, { slots }) => () => h("div", slots.default?.()) }),
}))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: defineComponent({ render: () => null }) }))

import { ConsoleRequestError } from "../src/console/runtime/client/request"
import { loadConsoleNavigation } from "../src/console/runtime/client/sections"
import { consoleSignInURL } from "../src/console/runtime/client/sign-in"
import ConsoleHome from "../src/console/runtime/components/console-home.vue"
import ConsoleRail from "../src/console/runtime/components/console-rail.vue"

const slot = defineComponent({ setup: (_props, { slots }) => () => h("div", slots.default?.()) })
const stubs: Record<string, Component> = {
  UButton: defineComponent({
    props: { label: String, loading: Boolean, onClick: Function, to: String },
    setup: props => () => props.to
      ? h("a", { href: props.to }, props.label)
      : h("button", { "data-button": props.label, "data-loading": props.loading, onClick: props.onClick }, props.label),
  }),
  UDashboardNavbar: defineComponent({ props: { title: String }, setup: props => () => h("h1", props.title) }),
  UDashboardPanel: defineComponent({ setup: (_props, { slots }) => () => h("div", [slots.header?.(), slots.body?.()]) }),
  UDashboardSearchButton: slot,
  UDropdownMenu: slot,
  UIcon: defineComponent({ props: { name: String }, setup: props => () => h("span", { "data-icon": props.name }) }),
  USkeleton: defineComponent({ setup: () => () => h("div", { "data-skeleton": "" }) }),
  UTooltip: slot,
}

function mount(component: Component, props: Record<string, unknown>) {
  const view = new Window()
  const root = view.document.createElement("div")
  const app = createApp(component, props)
  for (const [name, stub] of Object.entries(stubs)) app.component(name, stub)
  // The tests supply only the Nuxt UI components that the signed-out pages render.
  app.config.warnHandler = () => {}
  app.mount(root)
  const buttons = () => [...root.querySelectorAll("button")].map(button => button.getAttribute("data-button") ?? button.getAttribute("aria-label"))
  const click = (label: string) => root.querySelector(`[data-button="${label}"]`)?.dispatchEvent(new view.MouseEvent("click"))
  return { app, buttons, click, root }
}

const signedOut = () => Promise.reject(new ConsoleRequestError(401))

/** A document whose visibility the test sets, with the sign-in page meta tag of a Console page. The Overview reads only these members. */
function stubDocument(signInPage?: string): { show: () => void } {
  const target = new EventTarget()
  const meta = { getAttribute: (name: string) => (name === "content" ? signInPage : null) }
  const querySelector = (selector: string) => (signInPage && selector === 'meta[name="vitehub-console-sign-in"]' ? meta : null)
  const document = Object.assign(target, { querySelector, visibilityState: "hidden" })
  vi.stubGlobal("document", document)
  return {
    show: () => {
      document.visibilityState = "visible"
      target.dispatchEvent(new Event("visibilitychange"))
    },
  }
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe("signed-out Console", () => {
  it("gives the Overview one state with one action, and opens the Console when the person returns signed in", async () => {
    mocks.requestConsole.mockImplementation(signedOut)
    const tab = stubDocument()
    const { app, buttons, click, root } = mount(ConsoleHome, {
      agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv", searchBase: "/search", sectionsBase: "/home/sections",
    })
    try {
      await vi.waitFor(() => expect(root.querySelector("h2")?.textContent).toBe("Sign in to use the Console"))
      expect(root.textContent).toContain("You are not signed in, or your session ended. Sign in, then come back to this tab.")
      // No project header and no Reload: they repeated the title and could not sign anyone in.
      expect(root.textContent).not.toContain("ViteHub Console")
      expect(buttons()).toEqual(["Check again"])
      expect(root.querySelector("[role=status]")?.textContent).toBe("")

      click("Check again")
      await vi.waitFor(() => expect(root.querySelector("[role=status]")?.textContent).toBe("You are still not signed in."))
      expect(mocks.requestConsole).toHaveBeenCalledTimes(2)

      // The person signs in in another tab. Coming back to this one is enough.
      mocks.requestConsole.mockResolvedValue({ auth: false, projectName: "demo", sections: ["kv"] })
      tab.show()
      await vi.waitFor(() => expect(root.textContent).toContain("demo"))
      expect(root.textContent).not.toContain("Sign in to use the Console")
      expect(root.querySelector('button[aria-label="Open KV"]')).not.toBeNull()
    }
    finally { app.unmount() }
  })

  it("links the signed-out Overview to the sign-in page that the Console page names, with the way back", async () => {
    mocks.requestConsole.mockImplementation(signedOut)
    stubDocument("/sign-in")
    vi.stubGlobal("window", Object.assign(new EventTarget(), { location: new URL("http://vitehub.local/portal/_vitehub/?from=mail") }))
    const { app, root } = mount(ConsoleHome, {
      agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv", searchBase: "/search", sectionsBase: "/sign-in-page/sections",
    })
    try {
      await vi.waitFor(() => expect(root.querySelector("h2")?.textContent).toBe("Sign in to use the Console"))
      expect(root.textContent).toContain("You are not signed in, or your session ended.")
      expect(root.textContent).not.toContain("come back to this tab")
      const links = [...root.querySelectorAll("a")].map(link => [link.textContent, link.getAttribute("href")])
      expect(links).toEqual([["Sign in", "/sign-in?redirect=%2Fportal%2F_vitehub%2F%3Ffrom%3Dmail"]])
      expect(root.querySelector('[data-button="Check again"]')).toBeNull()
    }
    finally { app.unmount() }
  })

  it("keeps the Overview error and its retry for failures other than sign-in", async () => {
    mocks.requestConsole.mockRejectedValue(new ConsoleRequestError(503))
    const { app, buttons, root } = mount(ConsoleHome, {
      agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv", searchBase: "/search", sectionsBase: "/unavailable/sections",
    })
    try {
      await vi.waitFor(() => expect(root.textContent).toContain("Could not load sections"))
      expect(buttons()).toContain("Try again")
      expect(root.textContent).not.toContain("Sign in to use the Console")
    }
    finally { app.unmount() }
  })

  it("offers no retry in the rail without a session, then shows the sections and the account once the Console answers", async () => {
    mocks.requestConsole.mockImplementation(signedOut)
    mocks.getSession.mockResolvedValue({ data: { session: { id: "session" }, user: { email: "ada@example.com", name: "Ada Lovelace" } } })
    const base = "/rail/sections"
    const { app, buttons, root } = mount(ConsoleRail, { sectionsBase: base })
    try {
      await vi.waitFor(() => expect(root.querySelector("[data-skeleton]")).toBeNull())
      expect(buttons()).not.toContain("Retry loading primitives")

      // The Overview loads the sections after the person signs in. The rail shows what that request returned.
      mocks.requestConsole.mockResolvedValue({ auth: true, sections: ["kv"] })
      await loadConsoleNavigation(base)
      await vi.waitFor(() => expect(buttons()).toContain("KV"))
      await vi.waitFor(() => expect(buttons()).toContain("Ada Lovelace"))
      expect(mocks.getSession).toHaveBeenCalledTimes(1)
    }
    finally { app.unmount() }
  })

  it("keeps the rail retry for failures other than sign-in", async () => {
    mocks.requestConsole.mockRejectedValue(new ConsoleRequestError(503))
    const { app, buttons, root } = mount(ConsoleRail, { sectionsBase: "/rail-unavailable/sections" })
    try {
      await vi.waitFor(() => expect(root.querySelector("[data-skeleton]")).toBeNull())
      expect(buttons()).toContain("Retry loading primitives")
    }
    finally { app.unmount() }
  })

  it("links only to a sign-in page on the Console's origin, and keeps that page's own query", () => {
    const page = (content: string | null) => ({
      document: { querySelector: () => (content === null ? null : { getAttribute: () => content }) },
      location: { origin: "http://vitehub.local", pathname: "/_vitehub/kv", search: "?store=cache" },
    })
    expect(consoleSignInURL(page("/?signin=1"))).toBe("/?signin=1&redirect=%2F_vitehub%2Fkv%3Fstore%3Dcache")
    for (const content of [null, "", "sign-in", "//evil.example/sign-in", "https://evil.example/sign-in"]) {
      expect(consoleSignInURL(page(content))).toBeUndefined()
    }
  })
})
