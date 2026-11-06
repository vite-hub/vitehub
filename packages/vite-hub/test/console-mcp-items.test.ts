import { createRenderer, ssrContextKey } from "vue"
import { expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/request", () => ({ requestConsoleOperation: mocks.request }))
vi.mock("../src/console/runtime/components/console-mcp-content.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-schema-form.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-state.vue", () => ({ default: {} }))

import Items from "../src/console/runtime/components/console-mcp-items.vue"
import type { ConsoleMcpConnection, ConsoleMcpPage } from "../src/console/runtime/mcp-client"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

it("loads more than ten resource pages before requesting templates that share its OAuth grant", async () => {
  const connection: ConsoleMcpConnection = { auth: "oauth", createdAt: new Date().toISOString(), id: "mcp_test", label: "Test", sameOrigin: true, status: "connected", url: "https://app.example/mcp" }
  type Page = ConsoleMcpPage & { connection: ConsoleMcpConnection }
  let finishPage: ((page: Page) => void) | undefined
  const firstPage = new Promise<Page>(resolve => { finishPage = resolve })
  const kinds: unknown[] = []
  mocks.request.mockImplementation((_operation: string, input: Record<string, unknown>) => {
    kinds.push(input.kind)
    return kinds.length === 1 ? firstPage : Promise.resolve({ connection, items: [], ...(input.kind === "resources" && kinds.length < 12 ? { nextCursor: `page-${kinds.length + 1}` } : {}) })
  })
  const app = renderer.createApp({ ...Items, render: () => null }, { connection, kind: "resources", peers: [connection] })
  app.provide(ssrContextKey, {})
  try {
    app.mount({})
    await vi.waitFor(() => expect(kinds).toContain("resources"))
    expect(kinds).toEqual(["resources"])
    finishPage!({ connection, items: [], nextCursor: "next" })
    await vi.waitFor(() => expect(kinds).toEqual([...Array.from({ length: 12 }, () => "resources"), "resource-templates"]))
    expect(mocks.request.mock.calls[1]![1]).toMatchObject({ cursor: "next" })
    expect(mocks.request.mock.calls[11]![1]).toMatchObject({ cursor: "page-12" })
  }
  finally {
    finishPage!({ connection, items: [] })
    app.unmount()
    mocks.request.mockReset()
  }
})

it.each([
  { cursors: ["same", "same"], pages: 2, message: "repeated pagination cursor" },
  { cursors: ["first", "second", "first"], pages: 3, message: "repeated pagination cursor" },
  { cursors: [], pages: 1_000, message: "1,000 pages" },
])("stops pagination with a visible error: $message ($pages requests)", async ({ cursors, pages, message }) => {
  const connection: ConsoleMcpConnection = { auth: "oauth", createdAt: new Date().toISOString(), id: "mcp_test", label: "Test", sameOrigin: true, status: "connected", url: "https://app.example/mcp" }
  const failed = vi.fn()
  let calls = 0
  mocks.request.mockImplementation(async () => {
    calls++
    // Keep the failing implementation finite too, so it cannot hang the test process.
    if (calls > 1_005) throw new Error("Pagination test guard reached")
    return { connection, items: [], nextCursor: cursors[(calls - 1) % cursors.length] ?? `page-${calls}` }
  })
  const app = renderer.createApp({ ...Items, render: () => null }, { connection, kind: "resources", onFailed: failed, peers: [connection] })
  app.provide(ssrContextKey, {})
  try {
    const view = app.mount({})
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce())
    expect(Reflect.get(view.$, "setupState")).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining(message) }) })
    expect(calls).toBe(pages)
    expect(failed).toHaveBeenCalledOnce()
  }
  finally {
    app.unmount()
    mocks.request.mockReset()
  }
})
