// @vitest-environment happy-dom
import { createRenderer, nextTick, ssrContextKey } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { afterEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/request", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/request")>(),
  requestConsole: mocks.request,
}))
vi.mock("../src/console/runtime/components/console-frame.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-usage.vue", () => ({ default: {} }))

import ConsoleApp from "../src/console/runtime/components/console-app.vue"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

interface AgentsState {
  detailsMaximized: boolean
  detailsOpen: boolean
  inspectorActiveSurface: string
  inspectorOpenViews: string[]
  inspectorOpenPaths: string[]
  inspectorSelectedPath: string | undefined
  inspectorTab: string
  selectCapability: (id?: string) => void
  selectedCapabilityId: string | undefined
  selectedTriggeredBy: string | undefined
  selectInvocation: (invocation: { agent: string, id: string }) => Promise<void>
  sessionsOpen: boolean
}

let unmount: (() => void) | undefined
afterEach(() => {
  unmount?.()
  mocks.request.mockReset()
})

async function mountAgents(path: string) {
  // Nothing loads, so the page keeps the route of the test.
  mocks.request.mockImplementation(() => new Promise(() => {}))
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { component: {}, name: "vitehub-console-agents", path: "/agents" },
      { component: {}, name: "vitehub-console-agent", path: "/agents/:agent" },
      { component: {}, name: "vitehub-console-invocation", path: "/agents/:agent/invocations/:invocation" },
      { component: {}, name: "vitehub-console-usage", path: "/usage" },
    ],
  })
  await router.push(path)
  const push = vi.spyOn(router, "push")
  const app = renderer.createApp({ ...ConsoleApp, render: () => null }, {
    agentsBase: "/agents-api", apiBase: "/invocations", capabilitiesBase: "/capabilities", definitionsBase: "/definitions",
    hostBase: "", kvBase: "/kv", searchBase: "/search", sectionsBase: "/sections", usageBase: "/usage-api",
  })
  app.use(router)
  app.provide(ssrContextKey, {})
  const instance = app.mount({})
  unmount = () => app.unmount()
  await nextTick()
  // SAFETY: the test reads and writes the setup state of the page it mounts.
  return { push, router, state: (instance.$ as unknown as { setupState: AgentsState }).setupState }
}

it("restores the session filters, the details panel, and its tab from the URL", async () => {
  const { state } = await mountAgents("/agents/support/invocations/i1?capability=web&triggeredBy=Maxi&tab=trace&details=max&sessions=open")
  expect(state.selectedCapabilityId).toBe("web")
  expect(state.selectedTriggeredBy).toBe("Maxi")
  expect(state.sessionsOpen).toBe(true)
  expect(state.detailsOpen).toBe(true)
  expect(state.detailsMaximized).toBe(true)
  expect(state.inspectorTab).toBe("trace")
  expect(state.inspectorActiveSurface).toBe("view:trace")
  expect(state.inspectorOpenViews).toEqual(["trace"])
})

it("keeps the filters and the details panel when another session opens, and Back returns to the last one", async () => {
  const { push, router, state } = await mountAgents("/agents/support/invocations/i1?capability=web&tab=trace&details=open&sessions=open")
  await state.selectInvocation({ agent: "support", id: "i2" })
  await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe("/agents/support/invocations/i2?capability=web&details=open&tab=trace"))
  expect(push).toHaveBeenLastCalledWith({
    name: "vitehub-console-invocation",
    params: { agent: "support", invocation: "i2" },
    query: { capability: "web", details: "open", tab: "trace" },
  })
  expect(state.sessionsOpen).toBe(false)
  state.inspectorTab = "workspace"
  await vi.waitFor(() => expect(router.currentRoute.value.query.tab).toBe("workspace"))
  router.back()
  await vi.waitFor(() => expect(state.inspectorTab).toBe("trace"))
  expect(state.inspectorActiveSurface).toBe("view:trace")
})

it("writes a changed filter and closes the details panel", async () => {
  const { router, state } = await mountAgents("/agents/support/invocations/i1?capability=web&triggeredBy=Maxi&details=open")
  state.selectCapability(undefined)
  await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe("/agents/support?triggeredBy=Maxi"))
  expect(state.detailsOpen).toBe(false)
})

it("searches sessions by title or ID and keeps the search when another session opens", async () => {
  const { router, state } = await mountAgents("/agents/support/invocations/i1?q=label")
  const search = state as unknown as AgentsState & { matchesSessionSearch: (item: { id: string, title?: string }) => boolean, sessionSearch: string }
  expect(search.sessionSearch).toBe("label")
  expect(search.matchesSessionSearch({ id: "ainv_1", title: "Label follow-up issues" })).toBe(true)
  expect(search.matchesSessionSearch({ id: "ainv_label", title: "Other" })).toBe(true)
  expect(search.matchesSessionSearch({ id: "ainv_2", title: "Triage" })).toBe(false)
  await state.selectInvocation({ agent: "support", id: "i2" })
  await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe("/agents/support/invocations/i2?q=label"))
})

it.each(["open", "max"])("opens the default Details surface from details=%s", async (details) => {
  const { state } = await mountAgents(`/agents/support/invocations/i1?details=${details}`)
  expect(state.detailsOpen).toBe(true)
  expect(state.inspectorTab).toBe("details")
  expect(state.inspectorActiveSurface).toBe("view:details")
  expect(state.inspectorOpenViews).toEqual(["details"])
})

it("restores the default Details surface when only the panel state changes", async () => {
  const { router, state } = await mountAgents("/agents/support/invocations/i1")
  await router.push({ query: { details: "open" } })
  await nextTick()
  expect(state.inspectorActiveSurface).toBe("view:details")
})

it.each(["details", "trace"])("restores %s while retaining an open file without writing another history entry", async (tab) => {
  const view = `/agents/support/invocations/i1?details=open${tab === "details" ? "" : `&tab=${tab}`}&file=notes.md`
  const { push, router, state } = await mountAgents(view)
  expect(state.inspectorSelectedPath).toBe("notes.md")
  expect(state.inspectorActiveSurface).toBe(`view:${tab}`)
  await router.push({ query: { details: "open", tab: "workspace", file: "notes.md" } })
  await nextTick()
  push.mockClear()
  router.back()
  await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe(view))
  expect(state.inspectorTab).toBe(tab)
  expect(state.inspectorActiveSurface).toBe(`view:${tab}`)
  expect(state.inspectorOpenPaths).toContain("notes.md")
  expect(push).not.toHaveBeenCalled()
  router.forward()
  await vi.waitFor(() => expect(state.inspectorActiveSurface).toBe("file:notes.md"))
  expect(push).not.toHaveBeenCalled()
})

it("restores a previous session's file and preserves Forward navigation", async () => {
  const first = "/agents/support/invocations/i1?details=open&tab=workspace&file=notes.md"
  const { push, router, state } = await mountAgents(first)
  await state.selectInvocation({ agent: "support", id: "i2" })
  await vi.waitFor(() => expect(router.currentRoute.value.params.invocation).toBe("i2"))
  expect(state.inspectorSelectedPath).toBeUndefined()
  expect(state.inspectorOpenPaths).toEqual([])
  push.mockClear()
  router.back()
  await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe(first))
  expect(state.inspectorSelectedPath).toBe("notes.md")
  expect(state.inspectorOpenPaths).toEqual(["notes.md"])
  expect(state.inspectorActiveSurface).toBe("file:notes.md")
  expect(push).not.toHaveBeenCalled()
  router.forward()
  await vi.waitFor(() => expect(router.currentRoute.value.params.invocation).toBe("i2"))
  expect(state.inspectorSelectedPath).toBeUndefined()
  expect(push).not.toHaveBeenCalled()
})
