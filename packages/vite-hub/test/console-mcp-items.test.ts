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

it("requests templates only after the resource list that shares its OAuth grant, with no cursor", async () => {
  const connection: ConsoleMcpConnection = { auth: "oauth", createdAt: new Date().toISOString(), id: "mcp_test", label: "Test", sameOrigin: true, status: "connected", url: "https://app.example/mcp" }
  type Page = ConsoleMcpPage & { connection: ConsoleMcpConnection }
  let finishResources: ((page: Page) => void) | undefined
  const resources = new Promise<Page>(resolve => { finishResources = resolve })
  const inputs: Record<string, unknown>[] = []
  mocks.request.mockImplementation((_operation: string, input: Record<string, unknown>) => {
    inputs.push(input)
    return inputs.length === 1 ? resources : Promise.resolve({ connection, items: [] })
  })
  const app = renderer.createApp({ ...Items, render: () => null }, { connection, kind: "resources", peers: [connection] })
  app.provide(ssrContextKey, {})
  try {
    app.mount({})
    await vi.waitFor(() => expect(inputs).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(inputs).toEqual([{ id: "mcp_test", kind: "resources" }])
    finishResources!({ connection, items: [] })
    await vi.waitFor(() => expect(inputs).toEqual([{ id: "mcp_test", kind: "resources" }, { id: "mcp_test", kind: "resource-templates" }]))
  }
  finally {
    finishResources!({ connection, items: [] })
    app.unmount()
    mocks.request.mockReset()
  }
})
