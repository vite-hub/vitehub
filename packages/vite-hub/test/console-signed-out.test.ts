// @vitest-environment happy-dom
import { Window } from "happy-dom"
import { createApp, defineComponent, h, ref, type Component } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ requestConsole: vi.fn() }))
vi.mock("@nuxt/ui/composables", () => ({ defineShortcuts: vi.fn() }))
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

import { consoleProject, setConsoleProject } from "../src/console/runtime/client/project"
import { ConsoleRequestError } from "../src/console/runtime/client/request"
import { loadConsoleNavigation } from "../src/console/runtime/client/sections"
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
  UEmpty: defineComponent({
    props: { description: String, title: String },
    setup: (props, { attrs, slots }) => () => h("div", attrs, [h("h2", props.title), slots.description?.() ?? props.description, slots.body?.()]),
  }),
  UDashboardPanel: defineComponent({ setup: (_props, { slots }) => () => h("div", [slots.header?.(), slots.body?.()]) }),
  UDropdownMenu: defineComponent({
    props: { items: Array },
    setup: (props, { slots }) => () => h("div", [slots.default?.(), ...(props.items ?? []).flat().map((item) => {
      const action = item as { label?: string, onSelect?: () => void }
      return action.onSelect ? h("button", { "data-button": action.label, onClick: action.onSelect }, action.label) : null
    })]),
  }),
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
  // A sidebar row is named by its label text, which stays in the row while the sidebar is collapsed.
  const buttons = () => [...root.querySelectorAll("button")].map(button => button.getAttribute("data-button") ?? button.getAttribute("aria-label") ?? button.querySelector(".vitehub-sidebar__label")?.textContent ?? null)
  const click = (label: string) => root.querySelector(`[data-button="${label}"]`)?.dispatchEvent(new view.MouseEvent("click"))
  return { app, buttons, click, root }
}

const signedOut = () => Promise.reject(new ConsoleRequestError(401))

/** A document whose visibility the test sets. The Overview reads only these members. */
function stubDocument() {
  const target = new EventTarget()
  const document = Object.assign(target, { querySelector: () => null, visibilityState: "hidden" })
  vi.stubGlobal("document", document)
  return {
    document,
    show: () => {
      document.visibilityState = "visible"
      target.dispatchEvent(new Event("visibilitychange"))
    },
  }
}

const pageProject = consoleProject()

afterEach(() => {
  setConsoleProject(pageProject)
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe("Console that the app refuses", () => {
  it("gives the Overview one state with one action, and opens the Console when the person returns after a fix", async () => {
    mocks.requestConsole.mockImplementation(signedOut)
    const tab = stubDocument()
    const { app, buttons, click, root } = mount(ConsoleHome, {
      agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv", searchBase: "/search", sectionsBase: "/home/sections",
    })
    try {
      await vi.waitFor(() => expect(root.querySelector("h2")?.textContent).toBe("The app refused this Console"))
      expect(root.textContent).toContain("The app does not accept the signature of this Console. Set the key of the link on the app, then check again.")
      // No project header and no Reload: they repeated the title and could not fix access.
      expect(root.textContent).not.toContain("ViteHub Console")
      expect(buttons()).toEqual(["Check again"])
      expect(root.querySelector("[role=status]")?.textContent).toBe("")

      click("Check again")
      await vi.waitFor(() => expect(root.querySelector("[role=status]")?.textContent).toBe("The app still refuses this Console."))
      expect(mocks.requestConsole).toHaveBeenCalledTimes(2)

      // The person sets the key in another tab. Coming back to this one is enough.
      mocks.requestConsole.mockResolvedValue({ projectName: "demo", sections: ["kv"] })
      tab.show()
      await vi.waitFor(() => expect(root.textContent).toContain("demo"))
      expect(root.textContent).not.toContain("The app refused this Console")
      expect(root.querySelector('button[aria-label="Open KV"]')).not.toBeNull()
    }
    finally { app.unmount() }
  })

  it("checks again when the person came back while the first request was still waiting for its answer", async () => {
    let answerFirst: (error: unknown) => void = () => {}
    mocks.requestConsole.mockImplementationOnce(() => new Promise((_resolve, reject) => { answerFirst = reject }))
    mocks.requestConsole.mockResolvedValue({ projectName: "demo", sections: ["kv"] })
    const tab = stubDocument()
    const { app, root } = mount(ConsoleHome, {
      agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv", searchBase: "/search", sectionsBase: "/in-flight/sections",
    })
    try {
      await vi.waitFor(() => expect(mocks.requestConsole).toHaveBeenCalledTimes(1))
      // The person fixed access elsewhere and comes back before the request that left earlier answers 401.
      tab.show()
      answerFirst(new ConsoleRequestError(401))
      await vi.waitFor(() => expect(root.textContent).toContain("demo"))
      expect(mocks.requestConsole).toHaveBeenCalledTimes(2)
    }
    finally { app.unmount() }
  })

  it("keeps the Overview error and its retry for failures other than a refusal", async () => {
    mocks.requestConsole.mockRejectedValue(new ConsoleRequestError(503))
    const { app, buttons, root } = mount(ConsoleHome, {
      agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv", searchBase: "/search", sectionsBase: "/unavailable/sections",
    })
    try {
      await vi.waitFor(() => expect(root.textContent).toContain("Could not load sections"))
      expect(buttons()).toContain("Try again")
      expect(root.textContent).not.toContain("The app refused this Console")
    }
    finally { app.unmount() }
  })

  it("offers no retry in the rail while the app refuses the Console, then shows the sections once it answers", async () => {
    mocks.requestConsole.mockImplementation(signedOut)
    const base = "/rail/sections"
    const { app, buttons, root } = mount(ConsoleRail, { sectionsBase: base })
    try {
      await vi.waitFor(() => expect(root.querySelector("[data-skeleton]")).toBeNull())
      expect(buttons()).not.toContain("Retry loading primitives")

      // The Overview loads the sections again. The rail shows what that request returned.
      mocks.requestConsole.mockResolvedValue({ sections: ["kv"] })
      await loadConsoleNavigation(base)
      await vi.waitFor(() => expect(buttons()).toContain("KV"))
    }
    finally { app.unmount() }
  })

  it("keeps the rail retry for failures other than a refusal", async () => {
    mocks.requestConsole.mockRejectedValue(new ConsoleRequestError(503))
    const { app, buttons, root } = mount(ConsoleRail, { sectionsBase: "/rail-unavailable/sections" })
    try {
      await vi.waitFor(() => expect(root.querySelector("[data-skeleton]")).toBeNull())
      expect(buttons()).toContain("Retry loading primitives")
    }
    finally { app.unmount() }
  })
})
