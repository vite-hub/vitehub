import { createRenderer, nextTick, ssrContextKey } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { parseConsoleContributedSection } from "../src/console/runtime/definitions"
import { operationCell } from "../src/console/runtime/client/operation-view"

import type { Component } from "vue"
import type { RouteRecordRaw, Router } from "vue-router"

const mocks = vi.hoisted(() => ({ operation: vi.fn(), request: vi.fn() }))
vi.mock("../src/console/runtime/client/request", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/request")>(),
  requestConsole: mocks.request,
}))
vi.mock("../src/console/runtime/client/operation-view", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/operation-view")>(),
  loadOperationItems: mocks.operation,
}))
vi.mock("../src/console/runtime/client/read-only", () => ({ isConsoleSectionReadOnly: async () => false }))
vi.mock("../src/console/runtime/client/sections", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/sections")>(),
  loadConsoleNavigation: async () => undefined,
}))
vi.mock("@vite-hub/ui", () => ({ ChatMessage: {} }))
vi.mock("../src/console/runtime/components/console-frame.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))

import Channels from "../src/console/runtime/components/console-channels.vue"
import Definitions from "../src/console/runtime/components/console-definitions.vue"
import OperationView from "../src/console/runtime/components/console-operation-view.vue"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

const unmounts: Array<() => void> = []
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount()
  mocks.operation.mockReset()
  mocks.request.mockReset()
})

/** Runs the setup of a page under a router at `path`, without rendering, and spies on its navigations. */
async function mountPage<State>(component: Component, props: Record<string, unknown>, path: string, routes: RouteRecordRaw[]) {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  const push = vi.spyOn(router, "push")
  const replace = vi.spyOn(router, "replace")
  const app = renderer.createApp({ ...component, render: () => null }, props)
  app.use(router)
  app.provide(ssrContextKey, {})
  const instance = app.mount({})
  unmounts.push(() => app.unmount())
  await nextTick()
  // SAFETY: tests read and write the setup state of the page they mount.
  return { push, replace, router, state: (instance.$ as unknown as { setupState: State }).setupState }
}

async function settle(router: Router, query: Record<string, string>) {
  await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual(query))
}

const bases = { agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv", searchBase: "/search", sectionsBase: "/sections" }

describe("Definition catalogs", () => {
  const details = { description: "Queues.", icon: "i-lucide-list", id: "queues", label: "Queues", view: { kind: "definition-catalog", notice: "" } }
  const routes = [{ component: {}, meta: { consoleSection: "queues" }, name: "vitehub-console-queues", path: "/queues" }]

  it("searches Definition names from the URL and writes the search back", async () => {
    mocks.request.mockResolvedValue({
      definitions: ["console-index", "release-notes", "image-resize"].map(name => ({ file: `server/queues/${name}.ts`, name, source: "server/queues" })),
      kind: "definition-catalog",
      section: "queues",
    })
    const { replace, router, state } = await mountPage<{ search: string, visibleEntries: Array<{ id: string }> }>(Definitions, { ...bases, details }, "/queues?q=re", routes)
    await vi.waitFor(() => expect(state.visibleEntries.map(entry => entry.id)).toEqual(["release-notes", "image-resize"]))
    state.search = "notes"
    await vi.waitFor(() => expect(router.currentRoute.value.query.q).toBe("notes"))
    expect(replace).toHaveBeenCalledWith({ query: expect.objectContaining({ q: "notes" }) })
    expect(state.visibleEntries.map(entry => entry.id)).toEqual(["release-notes"])
  })
})

describe("Record tables such as Email", () => {
  const details = parseConsoleContributedSection({
    description: "Email.",
    icon: "i-lucide-mail",
    id: "email",
    label: "Email",
    view: { columns: [{ key: "subject", label: "Subject" }, { key: "to", label: "To" }, { filter: true, key: "delivery", label: "Delivery" }], kind: "record-table", notice: "" },
  })
  const routes = [{ component: {}, meta: { consoleSection: "email" }, name: "vitehub-console-email", path: "/email" }]
  const records = [
    { cells: { delivery: "Sent", subject: "Welcome", to: "ann@example.com" }, id: "outbox-1" },
    { cells: { delivery: "Failed", subject: "Reset", to: "ann@example.com" }, id: "outbox-2" },
    { cells: { delivery: "Failed", subject: "Invoice", to: "bo@example.com" }, id: "outbox-3" },
  ]

  it("keeps the filter flag of an owner column", () => {
    expect(details?.view).toMatchObject({ columns: [{ key: "subject" }, { key: "to" }, { filter: true, key: "delivery" }] })
  })

  it("filters by recipient and delivery status from the URL and ignores other columns", async () => {
    mocks.request.mockResolvedValue({ kind: "record-table", records, section: "email" })
    const { replace, router, state } = await mountPage<{
      clearRecordFilters: () => void
      filterColumns: Array<{ key: string, values: string[] }>
      setColumnFilter: (key: string, value: string) => void
      visibleRecords: Array<{ id: string }>
    }>(Definitions, { ...bases, details }, "/email?q=ann&filter.delivery=Failed&filter.subject=Welcome", routes)
    await vi.waitFor(() => expect(state.visibleRecords.map(row => row.id)).toEqual(["outbox-2"]))
    expect(state.filterColumns).toEqual([expect.objectContaining({ key: "delivery", values: ["Failed", "Sent"] })])
    state.setColumnFilter("delivery", "Sent")
    await settle(router, { "filter.delivery": "Sent", "filter.subject": "Welcome", q: "ann" })
    expect(replace).toHaveBeenCalledOnce()
    expect(state.visibleRecords.map(row => row.id)).toEqual(["outbox-1"])
    state.clearRecordFilters()
    await settle(router, {})
    expect(state.visibleRecords).toHaveLength(3)
  })
})

describe("Comments operation view", () => {
  const details = { description: "Comments.", icon: "i-lucide-message-square", id: "comments", label: "Comments", view: {
    columns: [{ key: "subject.id", label: "Subject" }, { key: "author.name", label: "Author" }, { format: "excerpt", key: "messages.0.body", label: "Comment" }, { format: "datetime", key: "updatedAt", label: "Updated" }],
    filters: [{ id: "all", input: {}, label: "All" }, { id: "open", input: { status: "open" }, label: "Open" }],
    kind: "operation-view",
    notice: "",
    operation: "comments.list",
  } }
  const routes = [{ component: {}, meta: { consoleSection: "comments" }, name: "vitehub-console-comments", path: "/comments" }]

  it("searches the page, author, and text of the loaded comments", async () => {
    mocks.operation.mockResolvedValue([
      { author: { name: "Ann" }, id: "1", messages: [{ body: "Typo in the hero" }], subject: { id: "/pricing" } },
      { author: { name: "Bo" }, id: "2", messages: [{ body: "Broken link" }], subject: { id: "/docs" } },
    ])
    const { router, state } = await mountPage<{ search: string, visibleItems: Array<{ id: string }> }>(OperationView, { definitionsBase: "/definitions", details, sectionsBase: "/sections" }, "/comments?filter=open&q=pricing", routes)
    await vi.waitFor(() => expect(state.visibleItems.map(item => item.id)).toEqual(["1"]))
    expect(mocks.operation).toHaveBeenLastCalledWith("/definitions", details.view, { status: "open" }, expect.anything())
    state.search = "bo"
    await settle(router, { filter: "open", q: "bo" })
    expect(state.visibleItems.map(item => item.id)).toEqual(["2"])
  })

  it("searches the full comment while keeping its displayed excerpt", async () => {
    const comment = { id: "1", messages: [{ body: `${"Intro text. ".repeat(10)}Needle after the excerpt` }] }
    const displayed = operationCell(comment, { format: "excerpt", key: "messages.0.body", label: "Comment" })
    expect(displayed).toHaveLength(90)
    expect(displayed).not.toContain("Needle")
    mocks.operation.mockResolvedValue([comment, { id: "2", messages: [{ body: "Other comment" }] }])
    const { state } = await mountPage<{ items: Array<{ id: string }>, visibleItems: Array<{ id: string }> }>(OperationView, { definitionsBase: "/definitions", details, sectionsBase: "/sections" }, "/comments?q=NEEDLE", routes)
    await vi.waitFor(() => expect(state.items).toHaveLength(2))
    expect(state.visibleItems.map(item => item.id)).toEqual(["1"])
  })

  it("searches normalized whitespace beyond the displayed excerpt and keeps raw text searchable", async () => {
    const comment = { id: "1", messages: [{ body: `${"Intro text. ".repeat(10)}First\n  second` }] }
    mocks.operation.mockResolvedValue([comment, { id: "2", messages: [{ body: "Other comment" }] }])
    const { router, state } = await mountPage<{ items: Array<{ id: string }>, search: string, visibleItems: Array<{ id: string }> }>(OperationView, { definitionsBase: "/definitions", details, sectionsBase: "/sections" }, "/comments?q=first%20second", routes)
    await vi.waitFor(() => expect(state.items).toHaveLength(2))
    expect(state.visibleItems.map(item => item.id)).toEqual(["1"])
    state.search = "First\n  second"
    await settle(router, { q: "First\n  second" })
    expect(state.visibleItems.map(item => item.id)).toEqual(["1"])
  })

  it("opens a thread from the URL and from its row, and keeps the list in step with the panel", async () => {
    const threads = { ...details, view: { ...details.view, detail: { kind: "comment-thread" } } }
    mocks.operation.mockResolvedValue([{ id: "1", status: "open" }, { id: "2", status: "open" }])
    const { push, router, state } = await mountPage<{
      items: Array<{ id: string, status: string }>
      removeItem: (id: string) => void
      replaceItem: (thread: object) => void
      selectedId: string | undefined
      selectedItem: { id: string } | undefined
    }>(OperationView, { definitionsBase: "/definitions", details: threads, sectionsBase: "/sections" }, "/comments?filter=open&thread=2", routes)
    await vi.waitFor(() => expect(state.selectedItem?.id).toBe("2"))
    state.selectedId = "1"
    await settle(router, { filter: "open", thread: "1" })
    expect(push).toHaveBeenCalledOnce()
    state.replaceItem({ id: "1", status: "resolved" })
    expect(state.items).toEqual([{ id: "1", status: "resolved" }, { id: "2", status: "open" }])
    state.removeItem("1")
    expect(state.items.map(item => item.id)).toEqual(["2"])
    state.selectedId = undefined
    await settle(router, { filter: "open" })
  })

  it("searches both the displayed date and its source timestamp", async () => {
    const comment = { id: "1", updatedAt: Date.UTC(2026, 0, 2, 3, 4) }
    expect(operationCell(comment, { format: "datetime", key: "updatedAt", label: "Updated" })).toBe("2026-01-02 03:04")
    mocks.operation.mockResolvedValue([comment, { id: "2", updatedAt: Date.UTC(2026, 0, 3) }])
    const { router, state } = await mountPage<{ items: Array<{ id: string }>, search: string, visibleItems: Array<{ id: string }> }>(OperationView, { definitionsBase: "/definitions", details, sectionsBase: "/sections" }, "/comments?q=2026-01-02%2003%3A04", routes)
    await vi.waitFor(() => expect(state.items).toHaveLength(2))
    expect(state.visibleItems.map(item => item.id)).toEqual(["1"])
    state.search = String(comment.updatedAt)
    await settle(router, { q: String(comment.updatedAt) })
    expect(state.visibleItems.map(item => item.id)).toEqual(["1"])
  })
})

describe("Channels", () => {
  const routes = [{ component: {}, name: "vitehub-console-channels", path: "/channels" }]

  it("searches threads and keeps the search when a thread of the Channel opens", async () => {
    mocks.request.mockImplementation(async (path: string) => path.endsWith("/threads")
      ? { threads: [{ invocationCount: 1, participants: ["Maxi"], thread: "telegram:1", title: "Refund" }, { invocationCount: 2, participants: ["Ana"], thread: "telegram:2" }] }
      : path.endsWith("/channels")
        ? { channels: [{ agent: "support", channel: "telegram", conversations: true, provider: "telegram", retention: {} }] }
        : { messages: [], retention: {} })
    const { push, router, state } = await mountPage<{ select: (query: Record<string, string>) => void, threadSearch: string, visibleThreads: Array<{ thread: string }> }>(
      Channels, { ...bases, channelsBase: "/api/channels" }, "/channels?agent=support&channel=telegram&q=ana", routes,
    )
    await vi.waitFor(() => expect(state.visibleThreads.map(thread => thread.thread)).toEqual(["telegram:2"]))
    state.select({ agent: "support", channel: "telegram", thread: "telegram:2" })
    await settle(router, { agent: "support", channel: "telegram", q: "ana", thread: "telegram:2" })
    expect(push).toHaveBeenCalledOnce()
    expect(state.threadSearch).toBe("ana")
  })
})
