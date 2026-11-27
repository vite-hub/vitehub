// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils"
import type { Window } from "happy-dom"
import type { DefineComponent } from "vue"
import { describe, expect, it, vi } from "vitest"

import type { SetupClient, SetupFeatureState } from "../src/console/runtime/client/setup"
import type { ConsoleNavigation } from "../src/console/runtime/client/sections"

const mocks = vi.hoisted(() => ({ connect: vi.fn(), navigation: vi.fn(), restart: vi.fn() }))
vi.mock("@vite-hub/ui", () => ({ MultiFileDiff: {} }))
vi.mock("../src/console/runtime/client/sections", () => ({ loadConsoleNavigation: mocks.navigation }))
vi.mock("../src/console/runtime/client/setup", async (original) => ({
  ...await original<typeof import("../src/console/runtime/client/setup")>(),
  connectSetup: mocks.connect,
  waitForSetupRestart: mocks.restart,
}))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))

import Setup from "../src/console/runtime/components/console-setup.vue"

function mountSetup() {
  type SetupComponent = DefineComponent<{ agentsBase: string, definitionsBase: string, kvBase: string, searchBase: string, sectionsBase: string }>
  return shallowMount<typeof Setup, SetupComponent>(Setup, {
    props: { agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv", searchBase: "/search", sectionsBase: "/sections" },
    global: { stubs: {
      UDashboardPanel: { template: "<div><slot /></div>" },
      UTooltip: { template: "<slot />" },
      UButton: { props: ["label"], template: "<button>{{ label }}</button>" },
      UInput: { props: ["modelValue"], template: "<input :value='modelValue' @input='$emit(\"update:modelValue\", $event.target.value)' />" },
      ULink: true, UEmpty: true, UAlert: { props: ["title", "description"], template: "<div>{{ title }} {{ description }}</div>" },
    } },
  })
}

describe("Console Setup actions", () => {
  it.each([false, true])("preserves a failed Apply unless a new server is observed (restarted: %s)", async (restarted) => {
    const support = { level: "native", detail: "KV support" } as const
    const client: SetupClient = {
      serverId: "test-server",
      catalog: async () => ({ hosts: ["node"], features: [{ id: "kv", title: "KV", summary: "Store data", docs: "/kv", hosts: { node: support } }] }),
      status: async () => ({ root: "/app", framework: "vite", config: { file: "vite.config.ts" }, host: { name: "node", source: "config" }, packageManager: "pnpm", features: [{ id: "kv", enabled: "off", reason: "config", support, missingPackages: [] }] }),
      plan: vi.fn<SetupClient["plan"]>().mockResolvedValue({ status: "planned", planId: "test-plan" }),
      apply: vi.fn<SetupClient["apply"]>().mockRejectedValue(new Error("Apply request failed")),
      events: vi.fn<SetupClient["events"]>().mockResolvedValue(),
    }
    mocks.connect.mockResolvedValue(client)
    mocks.navigation.mockResolvedValue({ setup: "/setup", readOnly: [] })
    mocks.restart.mockResolvedValue(restarted ? "new-server" : undefined)
    const { window } = globalThis as unknown as Pick<Window, "window">
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {})
    const wrapper = mountSetup()
    try {
      await flushPromises()
      await wrapper.get("form").trigger("submit")
      await flushPromises()
      await wrapper.findAll("button").find(button => button.text() === "Apply")!.trigger("click")
      await flushPromises()
      expect(mocks.restart).toHaveBeenCalledWith("/setup", "test-server")
      if (restarted) expect(reload).toHaveBeenCalledOnce()
      else {
        expect(reload).not.toHaveBeenCalled()
        expect(wrapper.text()).toContain("Apply request failed")
        expect(wrapper.text()).toContain("Plan again")
        expect(wrapper.text()).not.toContain("The change is written")
      }
    }
    finally {
      wrapper.unmount()
      sessionStorage.clear()
      reload.mockRestore()
    }
  })

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
    mocks.navigation.mockResolvedValue({ setup: "/setup", readOnly: [] })
    const wrapper = mountSetup()
    try {
      await flushPromises()
      await wrapper.get('nav[aria-label="Features"] button').trigger("click")
      if (level === "explicit") await wrapper.get("#setup-option-database\\.connection").setValue("file:app.db")
      await wrapper.get("form").trigger("submit")
      expect(plan).toHaveBeenCalledWith({ action, features: ["database"], ...(level === "explicit" ? { options: ["database.connection=file:app.db"] } : {}) })
    }
    finally { wrapper.unmount() }
  })

  it.each<{ name: string, readOnly: ConsoleNavigation["readOnly"], writable: boolean }>([
    { name: "a setup:read grant", readOnly: ["setup"], writable: false },
    { name: "a writable Setup grant", readOnly: [], writable: true },
    { name: "a read-only grant for another section", readOnly: ["kv"], writable: true },
  ])("allows previews and respects $name when applying", async ({ readOnly, writable }) => {
    const support = { level: "native", detail: "Database support" } as const
    const client: SetupClient = {
      serverId: "test-server",
      catalog: async () => ({ hosts: ["node"], features: [{ id: "database", title: "Database", summary: "Store data", docs: "/database", hosts: { node: support } }] }),
      status: async () => ({ root: "/app", framework: "vite", config: { file: "vite.config.ts" }, host: { name: "node", source: "config" }, packageManager: "pnpm", features: [{ id: "database", enabled: "off", reason: "config", support, missingPackages: [] }] }),
      plan: vi.fn<SetupClient["plan"]>().mockResolvedValue({ status: "planned", planId: "test-plan" }),
      apply: vi.fn<SetupClient["apply"]>().mockResolvedValue({ status: "applied" }),
      events: vi.fn<SetupClient["events"]>().mockResolvedValue(),
    }
    mocks.connect.mockResolvedValue(client)
    mocks.navigation.mockResolvedValue({ setup: "/setup", readOnly })
    const wrapper = mountSetup()
    try {
      await flushPromises()
      await wrapper.get("form").trigger("submit")
      await flushPromises()
      expect(client.plan).toHaveBeenCalledWith({ action: "add", features: ["database"] })
      const apply = wrapper.findAll("button").find(button => button.text() === "Apply")
      expect(Boolean(apply)).toBe(writable)
      if (apply) {
        await apply.trigger("click")
        await flushPromises()
        expect(client.apply).toHaveBeenCalledWith("test-plan")
      }
      else {
        expect(wrapper.text()).toContain("This access can only read Setup")
        expect(client.apply).not.toHaveBeenCalled()
        expect(client.events).not.toHaveBeenCalled()
      }
    }
    finally { wrapper.unmount() }
  })
})
