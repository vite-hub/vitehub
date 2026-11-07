// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils"
import type { DefineComponent } from "vue"
import { describe, expect, it, vi } from "vitest"

import type { SetupClient, SetupFeatureState } from "../src/console/runtime/client/setup"

const mocks = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock("@vite-hub/ui", () => ({ MultiFileDiff: {} }))
vi.mock("../src/console/runtime/client/sections", () => ({ loadConsoleNavigation: async () => ({ setup: "/setup" }) }))
vi.mock("../src/console/runtime/client/setup", async (original) => ({
  ...await original<typeof import("../src/console/runtime/client/setup")>(),
  connectSetup: mocks.connect,
}))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))

import Setup from "../src/console/runtime/components/console-setup.vue"

describe("Console Setup actions", () => {
  it.each([
    { name: "missing provider option", level: "explicit", fix: "Set database.connection", missingPackages: [], action: "add" },
    { name: "missing owner packages", level: "native", fix: undefined, missingPackages: ["@vite-hub/database"], action: "add" },
    { name: "complete enabled feature", level: "native", fix: undefined, missingPackages: [], action: "remove" },
    { name: "feature unsupported on this host", level: "unsupported", fix: "Set database: false", missingPackages: [], action: "remove" },
  ] as const)("plans $action for a $name", async ({ action, fix, level, missingPackages }) => {
    const support = { level, detail: "Database support", ...(level === "explicit" ? { option: "database.connection" } : {}) }
    const state: SetupFeatureState = { id: "database", enabled: "on", reason: "config", support, missingPackages, ...(fix ? { fix } : {}) }
    const plan = vi.fn<SetupClient["plan"]>().mockResolvedValue({ status: "unchanged" })
    const client: SetupClient = {
      serverId: "test-server", plan,
      catalog: async () => ({ hosts: ["node"], features: [{ id: "database", title: "Database", summary: "Store data", docs: "/database", hosts: { node: support } }] }),
      status: async () => ({ root: "/app", framework: "vite", config: { file: "vite.config.ts" }, host: { name: "node", source: "config" }, packageManager: "pnpm", features: [state] }),
      apply: vi.fn(), events: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)
    type SetupComponent = DefineComponent<{ agentsBase: string, definitionsBase: string, kvBase: string, searchBase: string, sectionsBase: string }>
    const wrapper = shallowMount<typeof Setup, SetupComponent>(Setup, {
      props: { agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv", searchBase: "/search", sectionsBase: "/sections" },
      global: { stubs: {
        UDashboardPanel: { template: "<div><slot /></div>" },
        UTooltip: { template: "<slot />" },
        UButton: { props: ["label"], template: "<button>{{ label }}</button>" },
        UInput: { props: ["modelValue"], template: "<input :value='modelValue' @input='$emit(\"update:modelValue\", $event.target.value)' />" },
        ULink: true, UEmpty: true, UAlert: true,
      } },
    })
    try {
      await flushPromises()
      await wrapper.get('nav[aria-label="Features"] button').trigger("click")
      if (level === "explicit") await wrapper.get("#setup-option-database\\.connection").setValue("file:app.db")
      await wrapper.get("form").trigger("submit")
      expect(plan).toHaveBeenCalledWith({ action, features: ["database"], ...(level === "explicit" ? { options: ["database.connection=file:app.db"] } : {}) })
    }
    finally { wrapper.unmount() }
  })
})
