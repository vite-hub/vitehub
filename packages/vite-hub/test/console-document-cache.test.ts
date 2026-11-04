// @vitest-environment happy-dom
import { createRenderer, nextTick, ssrContextKey } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn(), overview: vi.fn(), navigation: vi.fn() }))
vi.mock("../src/console/runtime/client/request", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/request")>(), requestConsole: mocks.request,
}))
vi.mock("../src/console/runtime/client/documents", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/documents")>(),
  createConsoleDocumentsClient: () => ({ overview: mocks.overview }),
}))
vi.mock("../src/console/runtime/client/sections", () => ({ loadConsoleNavigation: mocks.navigation }))
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
import type { ConsoleDocumentCollection, ConsoleDocumentSetup } from "../src/console/runtime/definitions"

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
}
const apps: Array<{ unmount(): void }> = []

beforeEach(() => {
  sessionStorage.clear()
  mocks.request.mockReset().mockImplementation(() => new Promise(() => {}))
  mocks.overview.mockReset().mockImplementation(() => new Promise(() => {}))
  mocks.navigation.mockReset().mockResolvedValue({ auth: true })
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ user: { id: "alice" }, session: { id: "alice-session" } })))
  vi.stubGlobal("requestIdleCallback", vi.fn())
})
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  vi.unstubAllGlobals()
})

async function mountDocuments() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/content", component: {} }] })
  await router.push("/content")
  const app = renderer.createApp({ ...Documents, render: () => null }, {
    agentsBase: "/agents", definitionsBase: "/definitions", documentsBase: "/documents",
    kvBase: "/kv", searchBase: "/search", sectionsBase: "/sections",
    details: { id: "content", label: "Content", view: { kind: "document-editor" } },
  })
  app.use(router)
  app.provide(ssrContextKey, {})
  apps.push(app)
  const instance = app.mount({})
  await nextTick()
  return (instance.$ as unknown as { setupState: DocumentState }).setupState
}

describe("Console document cache authorization", () => {
  it("does not restore an unscoped legacy cache", async () => {
    sessionStorage.setItem(cacheKey, JSON.stringify({ definitions, overview }))
    const state = await mountDocuments()
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalled())
    expect(state.collections).toEqual([])
    expect(state.overview).toBeUndefined()
  })

  it("waits for a validated identity before restoring that session's cache", async () => {
    let complete!: (value: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    sessionStorage.setItem(cacheKey, JSON.stringify({ identity, definitions, overview }))
    const state = await mountDocuments()
    expect(state.collections).toEqual([])
    expect(state.overview).toBeUndefined()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    complete(Response.json({ user: { id: "alice" }, session: { id: "alice-session" } }))
    await vi.waitFor(() => expect(state.collections[0]?.name).toBe("private"))
    expect(state.overview).toEqual(overview)
    expect(state.loading).toBe(false)
    expect(fetch).toHaveBeenCalledWith("/auth/get-session?disableCookieCache=true", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }))
  })

  it("does not show another user's cached content", async () => {
    sessionStorage.setItem(cacheKey, JSON.stringify({ identity, definitions, overview }))
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ user: { id: "bob" }, session: { id: "bob-session" } }))
    const state = await mountDocuments()
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalled())
    expect(state.collections).toEqual([])
    expect(state.overview).toBeUndefined()
  })

  it.each([null, { user: { id: "alice" } }])("discards the cache when identity metadata is missing: %j", async (session) => {
    sessionStorage.setItem(cacheKey, JSON.stringify({ identity, definitions, overview }))
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(session))
    const state = await mountDocuments()
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalled())
    expect(state.collections).toEqual([])
    expect(state.overview).toBeUndefined()
    expect(sessionStorage.getItem(cacheKey)).toBeNull()
  })

  it("disables caching without a stable authenticated identity", async () => {
    mocks.navigation.mockResolvedValueOnce({ auth: false })
    mocks.request.mockResolvedValueOnce(definitions)
    mocks.overview.mockResolvedValueOnce(overview)
    const state = await mountDocuments()
    await vi.waitFor(() => expect(state.overview).toEqual(overview))
    expect(state.collections).toHaveLength(1)
    expect(sessionStorage.getItem(cacheKey)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("persists fresh responses with their validated session", async () => {
    mocks.request.mockResolvedValueOnce(definitions)
    mocks.overview.mockResolvedValueOnce(overview)
    await mountDocuments()
    await vi.waitFor(() => expect(JSON.parse(sessionStorage.getItem(cacheKey)!)).toEqual({ identity, definitions, overview }))
  })

  it("restores Cloudflare Access data only for the validated Access identity", async () => {
    mocks.navigation.mockResolvedValueOnce({ auth: "cloudflare-access" })
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ email: "alice@example.com" }))
    sessionStorage.setItem(cacheKey, JSON.stringify({ identity: JSON.stringify(["cloudflare-access", "email", "alice@example.com"]), definitions, overview }))
    const state = await mountDocuments()
    await vi.waitFor(() => expect(state.collections).toHaveLength(1))
    expect(fetch).toHaveBeenCalledWith("/auth/identity", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }))
  })

  it.each([
    [401, "definitions"], [403, "definitions"], [401, "overview"], [403, "overview"],
  ] as const)("clears cached and displayed data after a %s from %s and ignores pending responses", async (status, source) => {
    sessionStorage.setItem(cacheKey, JSON.stringify({ identity, definitions, overview }))
    let fail!: (error: unknown) => void
    let complete!: (value: unknown) => void
    const failed = source === "definitions" ? mocks.request : mocks.overview
    const pending = source === "definitions" ? mocks.overview : mocks.request
    failed.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    pending.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const state = await mountDocuments()
    await vi.waitFor(() => expect(state.collections).toHaveLength(1))
    fail(new ConsoleRequestError(status))
    await vi.waitFor(() => expect(source === "definitions" ? state.error : state.overviewError).toBeInstanceOf(ConsoleRequestError))
    complete(source === "definitions" ? overview : definitions)
    await nextTick()
    expect(state.collections).toEqual([])
    expect(state.setup).toBeUndefined()
    expect(state.overview).toBeUndefined()
    expect(sessionStorage.getItem(cacheKey)).toBeNull()
  })
})
