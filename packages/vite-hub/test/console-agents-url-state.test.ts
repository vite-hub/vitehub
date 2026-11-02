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
