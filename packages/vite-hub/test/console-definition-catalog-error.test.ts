// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils"
import { defineComponent, h } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { expect, it, vi } from "vitest"

vi.mock("../src/console/runtime/client/request", () => ({ requestConsole: vi.fn(async () => { throw new Error("The Console handler threw an error.") }) }))
vi.mock("../src/console/runtime/client/sections", () => ({ loadConsoleNavigation: vi.fn(async () => undefined) }))
vi.mock("../src/console/runtime/client/read-only", () => ({ isConsoleSectionReadOnly: vi.fn(async () => false) }))
// These components import Nuxt UI composables, which need a Nuxt or Vite app. The page's own template is under test.
vi.mock("../src/console/runtime/components/console-frame.vue", () => ({ default: { template: "<div><slot /></div>" } }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-state.vue", async () => {
  const { defineComponent, h } = await import("vue")
  return {
    default: defineComponent({
      props: { compact: Boolean, error: null, retry: Function, title: String },
      setup: props => () => h("section", { "data-state": props.compact ? "compact" : "page" }, props.title),
    }),
  }
})

import ConsoleDefinitions from "../src/console/runtime/components/console-definitions.vue"

const slot = { template: "<div><slot /></div>" }
const UEmpty = defineComponent({ props: { title: String }, setup: props => () => h("section", { "data-empty": "" }, props.title) })
const UDashboardSidebar = defineComponent({
  setup: (_props, { slots }) => () => h("aside", [slots.header?.({ collapsed: false }), slots.default?.({ collapsed: false })]),
})

it("shows a Definition catalog load failure in the page", async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/workflows", component: {} }] })
  await router.push("/workflows")
  const wrapper = mount(ConsoleDefinitions, {
    global: {
      plugins: [router],
      stubs: {
        ConsolePageHeader: slot, UButton: true, UDashboardPanel: slot,
        UDashboardSidebar, UEmpty, UIcon: true, USkeleton: true, USlideover: true, UTooltip: slot,
      },
    },
    props: {
      agentsBase: "/agents",
      definitionsBase: "/definitions",
      details: { description: "Inspect Workflow Definitions.", icon: "i-lucide-git-branch", id: "workflows", label: "Workflows", view: { kind: "definition-catalog", notice: "" } },
      kvBase: "/kv",
      searchBase: "/search",
      sectionsBase: "/sections",
    },
  })
  await flushPromises()
  expect(wrapper.findAll("[data-state]").map(state => [state.attributes("data-state"), state.text()])).toEqual([["page", "Couldn't load Workflows"]])
  expect(wrapper.find("[data-empty]").exists()).toBe(false)
  wrapper.unmount()
})
