import { createRenderer, nextTick, ssrContextKey } from "vue"
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/request", () => ({ requestConsole: mocks.request }))
vi.mock("../src/console/runtime/components/console-frame.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))

import Blob from "../src/console/runtime/components/console-blob.vue"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

interface BlobState {
  selectedPath: string | undefined
  blobs: Array<{ pathname: string }>
  loadingMore: boolean
  selectBlob: (pathname: string) => void
  loadObjects: (options: { append?: boolean, keepSelection?: boolean }) => Promise<void>
}

function page(paths: string[], hasMore = false) {
  return {
    blobs: paths.map(pathname => ({ pathname, uploadedAt: "2026-10-03", httpMetadata: {}, customMetadata: {} })),
    stores: ["default"], store: "default", prefix: "", limit: 100, hasMore,
    cursor: hasMore ? "next" : undefined,
  }
}

describe("Console Blob selection", () => {
  it.each([true, false])("preserves the applicable selection with append=%s", async (append) => {
    let resolveResponse: (value: unknown) => void = () => {}
    const pending = new Promise<unknown>(resolve => { resolveResponse = resolve })
    mocks.request.mockReset().mockResolvedValueOnce(page(["a", "b"], true)).mockReturnValueOnce(pending)
    const app = renderer.createApp({ ...Blob, render: () => null }, {
      agentsBase: "/agents", blobBase: "/blob", definitionsBase: "/definitions",
      kvBase: "/kv", searchBase: "/search", sectionsBase: "/sections",
    })
    app.provide(ssrContextKey, {})
    try {
      const instance = app.mount({})
      const state = (instance.$ as unknown as { setupState: BlobState }).setupState
      await nextTick()
      state.selectBlob("b")
      const loading = state.loadObjects({ append, keepSelection: true })
      if (append) {
        expect(state.loadingMore).toBe(true)
        state.selectBlob("a")
      }
      resolveResponse(page(["b", "c"]))
      await loading
      expect(state.selectedPath).toBe(append ? "a" : "b")
      expect(state.blobs.map(blob => blob.pathname)).toEqual(append ? ["a", "b", "c"] : ["b", "c"])
      expect(state.loadingMore).toBe(false)
    }
    finally {
      app.unmount()
    }
  })
})
