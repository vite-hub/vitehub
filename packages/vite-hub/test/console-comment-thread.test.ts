// @vitest-environment happy-dom
import type { CommentThread as Thread } from "@vite-hub/comments/client"
import type { CommentCan } from "@vite-hub/ui"
import type { ConsoleOperationView } from "../src/console/runtime/definitions"
import { createRenderer, ssrContextKey } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { afterEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/request", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/request")>(),
  requestConsoleOperation: mocks.request,
}))
vi.mock("@vite-hub/ui", () => ({ CommentThread: {}, provideComments: () => {}, useComments: () => ({}) }))
vi.mock("../src/console/runtime/components/console-frame.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))
import Panel from "../src/console/runtime/components/console-comment-thread.vue"
import OperationView from "../src/console/runtime/components/console-operation-view.vue"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})
const view: ConsoleOperationView = {
  kind: "operation-view", operation: "comments.list", notice: "", columns: [{ key: "id", label: "ID" }],
  detail: { kind: "comment-thread" },
  filters: [{ id: "all", label: "All", input: {} }, { id: "open", label: "Open", input: { status: "open" } }],
  link: { template: "{subject.id:path}?comment={n}", when: { path: "subject.kind", equals: "page" } },
}
const thread: Thread = {
  id: "hidden", n: 5, author: { id: "ana" }, subject: { id: "/pricing", kind: "page" }, anchor: { kind: "page" },
  messages: [], scope: "site", status: "resolved", createdAt: 1, updatedAt: 1,
}
const mounted: Array<() => void> = []
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
  mocks.request.mockReset()
})

it("derives Open page and action permissions from a fetched thread outside the active list", async () => {
  const own = { author: thread.author, body: "My reply", createdAt: 1, attachments: [], id: "owned", mentions: [], threadId: thread.id }
  const other = { ...own, id: "other", author: { id: "ben" } }
  mocks.request.mockImplementation(async (_path, operation) => operation === "comments.get" ? thread : {
    canWrite: false, user: { id: "ana" }, capabilities: { reply: false, resolve: true, deleteThread: false, edit: [own.id], delete: [other.id] },
  })
  const app = renderer.createApp({ ...Panel, render: () => null }, { id: thread.id, definitionsBase: "/definitions", view })
  app.provide(ssrContextKey, {})
  const instance = app.mount({})
  mounted.push(() => app.unmount())
  const state = (instance.$ as unknown as { setupState: { link?: string, loading: boolean, can: CommentCan } }).setupState
  expect(state.can("resolve", { thread })).toBe(false)
  await vi.waitFor(() => expect(state.loading).toBe(false))
  expect(state.link).toBe("/pricing?comment=5")
  expect(state.can("reply", { thread })).toBe(false)
  expect(state.can("resolve", { thread })).toBe(true)
  expect(state.can("edit", { thread, message: own })).toBe(true)
  expect(state.can("edit", { thread, message: other })).toBe(false)
  expect(state.can("delete", { thread, message: other })).toBe(true)
  expect(state.can("delete", { thread, message: own })).toBe(false)
  expect(state.can("delete", { thread })).toBe(false)
  expect(mocks.request).toHaveBeenCalledWith("/definitions", "comments.session", { subject: thread.subject, threadId: thread.id }, expect.anything())
})

it("reloads the active operation after changes and deletions to preserve filters and ordering", async () => {
  const first = { ...thread, id: "first", status: "open" }
  const second = { ...first, id: "second" }
  mocks.request.mockResolvedValueOnce([first, second]).mockResolvedValueOnce([second, first]).mockResolvedValueOnce([second]).mockResolvedValueOnce([])
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/comments", component: OperationView }] })
  await router.push("/comments?filter=open&thread=first")
  const app = renderer.createApp({ ...OperationView, render: () => null }, {
    definitionsBase: "/definitions", sectionsBase: "/sections", details: { id: "comments", label: "Comments", view },
  })
  app.use(router)
  app.provide(ssrContextKey, {})
  const instance = app.mount({})
  mounted.push(() => app.unmount())
  const state = (instance.$ as unknown as { setupState: { items: typeof first[], selectedId?: string, refreshItems: () => void } }).setupState
  await vi.waitFor(() => expect(state.items).toEqual([first, second]))
  state.refreshItems()
  await vi.waitFor(() => expect(state.items).toEqual([second, first]))
  state.refreshItems()
  await vi.waitFor(() => expect(state.items).toEqual([second]))
  expect(state.selectedId).toBe("first")
  state.refreshItems()
  await vi.waitFor(() => expect(state.items).toEqual([]))
  expect(mocks.request).toHaveBeenCalledTimes(4)
  for (const call of mocks.request.mock.calls) expect(call.slice(0, 3)).toEqual(["/definitions", "comments.list", { status: "open" }])
})
