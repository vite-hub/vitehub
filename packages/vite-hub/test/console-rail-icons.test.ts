// @vitest-environment happy-dom
import { Window } from "happy-dom"
import { createApp, defineComponent, h, nextTick } from "vue"
import { describe, expect, it, vi } from "vitest"

vi.mock("@nuxt/ui/composables", () => ({ defineShortcuts: vi.fn() }))
vi.mock("@vite-hub/auth/vue", () => ({ createAuthClient: vi.fn() }))
vi.mock("vue-router", () => ({
  useRoute: () => ({ name: "vitehub-console", params: {} }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock("../src/console/runtime/client/request", () => ({
  requestConsole: async () => ({
    auth: false,
    contributions: [{
      description: "Inspect custom definitions.",
      icon: "i-lucide-sparkles",
      id: "custom",
      label: "Custom",
      view: { kind: "definition-catalog", notice: "Read-only." },
    }],
    sections: ["kv", "custom"],
  }),
}))

import Rail from "../src/console/runtime/components/console-rail.vue"

describe("Console rail icons", () => {
  it("renders the shared icon for a known primitive and the descriptor icon for a contributed section", async () => {
    const root = new Window().document.createElement("div")
    const app = createApp(Rail, { sectionsBase: "/sections" })
    app.component("UTooltip", defineComponent({
      setup(_props, { slots }) { return () => h("div", slots.default?.()) },
    }))
    app.component("UIcon", defineComponent({
      props: { name: { required: true, type: String } },
      setup(props) { return () => h("span", { "data-icon-name": props.name }) },
    }))
    // The test supplies only the Nuxt UI components that contain or render section icons.
    app.config.warnHandler = () => {}
    app.mount(root)
    // A sidebar row is named by its label, which stays in the row while the sidebar is collapsed.
    const item = (label: string) => [...root.querySelectorAll("button")].find(button => button.querySelector(".vitehub-sidebar__label")?.textContent === label)
    try {
      await vi.waitFor(() => expect(item("KV")).toBeDefined())
      await nextTick()

      const kv = item("KV")
      expect(kv?.querySelector("svg")?.getAttribute("data-icon")).toBe("kv")
      expect(kv?.querySelector("[data-icon-name]")).toBeNull()

      const custom = item("Custom")
      expect(custom).toBeDefined()
      expect(custom?.querySelector("[data-icon-name]")?.getAttribute("data-icon-name")).toBe("i-lucide-sparkles")
      expect(custom?.querySelector("svg")).toBeNull()
    }
    finally { app.unmount() }
  })
})
