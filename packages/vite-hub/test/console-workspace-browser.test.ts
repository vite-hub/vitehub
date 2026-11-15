// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils"
import { createMemoryHistory, createRouter } from "vue-router"
import { expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/request", () => ({ requestConsole: mocks.request }))
vi.mock("../src/console/runtime/client/read-only", () => ({ isConsoleSectionReadOnly: async () => false }))
vi.mock("../src/console/runtime/client/sections", () => ({ loadConsoleNavigation: async () => undefined }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))
import Browser from "../src/console/runtime/components/console-workspace-browser.vue"
import Definitions from "../src/console/runtime/components/console-definitions.vue"

it("loads older revisions, opens one, and resets pagination for a different ref", async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/workspaces", component: {} }] })
  await router.push("/workspaces")
  const revision = (id: string, ref = "main") => ({ id, ref, createdAt: "2026-11-07T10:00:00.000Z" })
  const first = Array.from({ length: 20 }, (_, index) => revision(`rev-${index + 1}`))
  const older = revision("rev-21")
  mocks.request.mockImplementation(async (_base: string, options: { query: Record<string, string> }) => {
    const query = options.query
    const ref = query.ref ?? "main"
    return {
      repository: "bot", revision: query.revision ?? "rev-1", ref, paths: ["README.md"],
      history: {
        ref, refs: [{ name: "main", head: first[0] }, { name: "other", head: revision("other-head", "other") }],
        revisions: ref === "other" ? [revision("other-head", ref)] : query.cursor ? [older] : first,
        ...(ref === "main" && !query.cursor ? { cursor: "main:20" } : {}),
      },
    }
  })
  const wrapper = shallowMount(Browser, { props: { base: "/files", name: "bot" }, global: { plugins: [router] } })
  try {
    await flushPromises()
    const button = (text: string) => wrapper.findAll("button").find(item => item.text().includes(text))!
    await button("Load older").trigger("click")
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledWith("/files", expect.objectContaining({ query: { name: "bot", ref: "main", revision: "rev-1", cursor: "main:20" } }))
    await button("rev-21").trigger("click")
    await flushPromises()
    expect(router.currentRoute.value.query.revision).toBe("rev-21")
    expect(router.currentRoute.value.query.ref).toBe("main")
    expect(button("rev-21").attributes("aria-current")).toBe("true")
    expect(wrapper.text()).not.toContain("Load older")
    await button("other").trigger("click")
    await flushPromises()
    expect(router.currentRoute.value.query.ref).toBe("other")
    expect(router.currentRoute.value.query.revision).toBeUndefined()
    expect(wrapper.text()).not.toContain("rev-21")
  }
  finally { wrapper.unmount() }
})

it("clears Workspace revision, ref, and file when choosing another Definition and restores them with Back", async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/workspaces", component: {}, meta: { consoleSection: "workspaces" } }] })
  await router.push("/workspaces?definition=a&ref=run-a&revision=rev-a&file=README.md&embed=1")
  mocks.request.mockResolvedValue({
    section: "workspaces", kind: "definition-catalog",
    definitions: ["a", "b"].map(name => ({ name, file: `server/workspaces/${name}/workspace.ts`, source: "server-workspaces-directory-config", fields: [] })),
  })
  const wrapper = shallowMount(Definitions, {
    props: {
      agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv", searchBase: "/search", sectionsBase: "/sections", workspaceFilesBase: "/files",
      details: { id: "workspaces", label: "Workspaces", icon: "i-lucide-folder", description: "Workspaces", view: { kind: "workspace-browser", notice: "Files" } },
    },
    global: { plugins: [router], stubs: {
      ConsoleFrame: { template: "<div><slot /></div>" },
      UDashboardSidebar: { template: "<aside><slot :collapsed='false' /></aside>" },
      UTooltip: { template: "<slot />" },
    } },
  })
  try {
    await flushPromises()
    await wrapper.findAll("nav button").find(button => button.text() === "b")!.trigger("click")
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ definition: "b", embed: "1" })
    router.back()
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ definition: "a", ref: "run-a", revision: "rev-a", file: "README.md", embed: "1" })
  }
  finally { wrapper.unmount() }
})
