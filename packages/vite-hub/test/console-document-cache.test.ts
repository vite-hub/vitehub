// @vitest-environment happy-dom
import { createRenderer, nextTick, ssrContextKey } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn(), overview: vi.fn() }))
vi.mock("../src/console/runtime/client/request", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/request")>(), requestConsole: mocks.request,
}))
vi.mock("../src/console/runtime/client/documents", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/documents")>(),
  createConsoleDocumentsClient: () => ({ overview: mocks.overview }),
}))
vi.mock("../src/console/runtime/components/console-document-editor.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-document-dashboard.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-document-list.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-document-settings.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-media-library.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-media-picker.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))

import Documents from "../src/console/runtime/components/console-documents.vue"
import { ConsoleRequestError } from "../src/console/runtime/client/request"
import type { ConsoleDocumentOverview } from "../src/console/runtime/client/documents"
import type { ConsoleDocumentCollection, ConsoleDocumentSetup, ConsoleSectionPage } from "../src/console/runtime/definitions"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})
const cacheKey = "vitehub.console.documents:/documents:content"
const identity = JSON.stringify(["session", "alice", "alice-session"])
const definitions = {
  section: "content", kind: "document-editor", setup: { schedule: { message: "Private setup" } },
  collections: [{ name: "private", label: "Private", path: "private/*.md", schema: { type: "object" } }],
}
const overview = { collections: [], activity: [{ id: "private-activity" }] }
interface DocumentState {
  collections: ConsoleDocumentCollection[]
  setup?: ConsoleDocumentSetup
  overview?: ConsoleDocumentOverview
  error?: unknown
  overviewError?: unknown
  loading: boolean
  pages: ConsoleSectionPage[]
  reload(): void
}
const apps: Array<{ unmount(): void }> = []

beforeEach(() => {
  sessionStorage.clear()
  mocks.request.mockReset().mockImplementation(() => new Promise(() => {}))
  mocks.overview.mockReset().mockImplementation(() => new Promise(() => {}))
  vi.stubGlobal("requestIdleCallback", vi.fn())
})
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  vi.unstubAllGlobals()
})

async function mountDocuments(path = "/content") {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { name: "vitehub-console-content", path: "/content", component: {} },
    { name: "vitehub-console-content--settings", path: "/content/-/settings", component: {}, meta: { consolePage: "settings" } },
  ] })
  await router.push(path)
  const app = renderer.createApp({ ...Documents, render: () => null }, {
    agentsBase: "/agents", definitionsBase: "/definitions", documentsBase: "/documents",
    kvBase: "/kv", searchBase: "/search", sectionsBase: "/sections",
    details: { id: "content", label: "Content", view: { kind: "document-editor" }, pages: [
      { id: "overview", label: "Overview", icon: "i-lucide-house", index: true, view: { kind: "document-dashboard" } },
      { id: "settings", label: "Settings", icon: "i-lucide-settings", view: { kind: "document-settings" } },
    ] },
  })
  app.use(router)
  app.provide(ssrContextKey, {})
  apps.push(app)
  const instance = app.mount({})
  await nextTick()
  return { state: (instance.$ as unknown as { setupState: DocumentState }).setupState, router }
}

describe("Console document cache authorization", () => {
  it.each([
    undefined,
    identity,
    JSON.stringify(["session", "bob", "bob-session"]),
    JSON.stringify(["cloudflare-access", "email", "alice@example.com"]),
  ])("ignores persisted responses while current authorization is pending: %s", async (owner) => {
    sessionStorage.setItem(cacheKey, JSON.stringify({ identity: owner, definitions, overview }))
    sessionStorage.setItem("unrelated", "preserved")
    const { state } = await mountDocuments()
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalled())
    expect(state.collections).toEqual([])
    expect(state.overview).toBeUndefined()
    expect(state.loading).toBe(true)
    expect(sessionStorage.getItem(cacheKey)).toBeNull()
    expect(sessionStorage.getItem("unrelated")).toBe("preserved")
  })

  it("only shows current responses after the same identity's grant narrows", async () => {
    sessionStorage.setItem(cacheKey, JSON.stringify({ identity, definitions, overview }))
    const currentDefinitions = { ...definitions, collections: [] }
    const currentOverview = { collections: [], activity: [] }
    mocks.request.mockResolvedValueOnce(currentDefinitions)
    mocks.overview.mockResolvedValueOnce(currentOverview)
    const { state } = await mountDocuments()
    await vi.waitFor(() => expect(state.loading).toBe(false))
    expect(state.collections).toEqual([])
    expect(state.setup).toEqual(definitions.setup)
    expect(state.overview).toEqual(currentOverview)
    expect(sessionStorage.getItem(cacheKey)).toBeNull()
  })

  it("renders current authorized responses without persisting a reusable grant", async () => {
    mocks.request.mockResolvedValueOnce(definitions)
    mocks.overview.mockResolvedValueOnce(overview)
    const { state } = await mountDocuments()
    await vi.waitFor(() => expect(state.overview).toEqual(overview))
    expect(state.collections[0]?.name).toBe("private")
    expect(sessionStorage.getItem(cacheKey)).toBeNull()
  })

  it.each([
    [401, "definitions"], [403, "definitions"], [401, "overview"], [403, "overview"],
  ] as const)("clears displayed data after a %s from %s and ignores pending responses", async (status, source) => {
    mocks.request.mockResolvedValueOnce(definitions)
    mocks.overview.mockResolvedValueOnce(overview)
    const { state } = await mountDocuments()
    await vi.waitFor(() => expect(state.collections).toHaveLength(1))
    await vi.waitFor(() => expect(state.overview).toEqual(overview))
    let fail!: (error: unknown) => void
    let complete!: (value: unknown) => void
    const failed = source === "definitions" ? mocks.request : mocks.overview
    const pending = source === "definitions" ? mocks.overview : mocks.request
    failed.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    pending.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    state.reload()
    expect(state.collections).toEqual([])
    expect(state.overview).toBeUndefined()
    fail(new ConsoleRequestError(status))
    await vi.waitFor(() => expect(source === "definitions" ? state.error : state.overviewError).toBeInstanceOf(ConsoleRequestError))
    complete(source === "definitions" ? overview : definitions)
    await nextTick()
    expect(state.collections).toEqual([])
    expect(state.setup).toBeUndefined()
    expect(state.overview).toBeUndefined()
    expect(sessionStorage.getItem(cacheKey)).toBeNull()
  })

  it.each([false, true])("keeps the Settings route only with a readable singleton: %s", async (readable) => {
    let complete!: (value: unknown) => void
    mocks.request.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const { state, router } = await mountDocuments("/content/-/settings")
    expect(state.pages.some(page => page.id === "settings")).toBe(true)
    const singleton = { ...definitions.collections[0], kind: "singleton", document: "site" }
    complete({ ...definitions, collections: readable ? [singleton] : [] })
    await vi.waitFor(() => expect(state.loading).toBe(false))
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(readable ? "/content/-/settings" : "/content"))
    expect(state.pages.some(page => page.id === "settings")).toBe(readable)
  })
})
