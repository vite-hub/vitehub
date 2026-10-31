// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils"
import { nextTick } from "vue"
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/request", () => ({ requestConsole: mocks.request }))
vi.mock("../src/console/runtime/client/read-only", () => ({ isConsoleSectionReadOnly: async () => false }))
vi.mock("../src/console/runtime/client/sections", () => ({ loadConsoleNavigation: async () => undefined }))
vi.mock("../src/console/runtime/components/console-frame.vue", () => ({ default: { template: "<div><slot /></div>" } }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))
vi.mock("vue-router", () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ replace: vi.fn() }),
}))

import Definitions from "../src/console/runtime/components/console-definitions.vue"
import type { ConsoleContributedSection } from "../src/console/runtime/definitions"

describe("Console definition loading announcements", () => {
  it.each(["definition-catalog", "record-table"] as const)("populates the existing %s status after mount and on later loads", async (kind) => {
    let complete: (value: unknown) => void = () => { throw new Error("No pending definition request") }
    mocks.request.mockReset().mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const details = (id: string): ConsoleContributedSection => ({
      id, label: id, icon: "i-lucide-list", description: id,
      view: kind === "definition-catalog" ? { kind, notice: "Metadata" } : { kind, notice: "Records", columns: [] },
    })
    const response = (section: string) => kind === "definition-catalog"
      ? { section, kind, definitions: [] }
      : { section, kind, records: [] }
    const wrapper = shallowMount(Definitions, {
      props: {
        agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv",
        searchBase: "/search", sectionsBase: "/sections", details: details("schedules"),
      },
      global: { stubs: {
        ConsoleFrame: false,
        ConsolePageHeader: { template: "<header><slot name='right' /></header>" },
        UDashboardPanel: { template: "<div><slot /></div>" },
        UTooltip: { props: ["text"], template: "<slot />" },
        UButton: { template: "<button><slot /></button>" },
        UDashboardSidebar: { template: "<aside><slot name='header' :collapsed='false' /></aside>" },
        UAvatar: true, UEmpty: true, UIcon: true, USkeleton: true, USlideover: true,
      } },
    })
    try {
      const status = wrapper.get('[role="status"]')
      expect(status.text()).toBe("")
      expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true)
      await nextTick()
      expect(status.text()).toBe("Loading…")
      complete(response("schedules"))
      await flushPromises()
      expect(status.text()).toBe("")

      await wrapper.get(`button[aria-label="Refresh ${kind === "definition-catalog" ? "definitions" : "records"}"]`).trigger("click")
      expect(status.text()).toBe("Loading…")
      complete(response("schedules"))
      await flushPromises()
      expect(status.text()).toBe("")

      await wrapper.setProps({ details: details("queues") })
      expect(status.text()).toBe("Loading…")
      complete(response("queues"))
      await flushPromises()
      expect(status.text()).toBe("")
      expect(wrapper.get('[role="status"]').element).toBe(status.element)
    }
    finally {
      wrapper.unmount()
    }
  })
})
