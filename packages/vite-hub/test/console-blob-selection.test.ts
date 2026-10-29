import { createRenderer, ssrContextKey } from "vue"
import { expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ access: vi.fn(), request: vi.fn() }))
vi.mock("../src/console/runtime/client/read-only", () => ({ isConsoleSectionReadOnly: mocks.access }))
vi.mock("../src/console/runtime/client/request", () => ({ requestConsole: mocks.request }))
vi.mock("../src/console/runtime/sections", () => ({ rememberConsoleSection: vi.fn() }))
vi.mock("vue-router", () => ({ useRoute: () => ({ query: { file: "images/selected.png" } }), useRouter: () => ({ replace: vi.fn() }) }))
vi.mock("../src/console/runtime/components/console-blob-detail.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-frame.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-media-browser.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-page-header.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))

import Blob from "../src/console/runtime/components/console-blob.vue"
import type { ConsoleBlobMediaClient } from "../src/console/runtime/client/blob-media"
import type { ConsoleMediaFile } from "../src/console/runtime/client/media-library"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

it("reloads selected metadata into the replacement client when read-only access resolves", async () => {
  let resolveGrant: ((readOnly: boolean) => void) | undefined
  const grant = new Promise<boolean>(resolve => { resolveGrant = resolve })
  mocks.access.mockReturnValue(grant)
  mocks.request.mockResolvedValue({
    blobs: [{ contentType: "image/png", httpEtag: "selected-etag", customMetadata: { alt: "Selected" }, httpMetadata: {}, pathname: "images/selected.png", size: 10, uploadedAt: "2026-01-01T00:00:00Z" }],
    hasMore: false, store: "default", stores: ["default"],
  })
  const app = renderer.createApp({ ...Blob, render: () => null }, { agentsBase: "/agents", blobBase: "/blob", definitionsBase: "/definitions", kvBase: "/kv", searchBase: "/search", sectionsBase: "/sections" })
  app.provide(ssrContextKey, {})
  try {
    const instance = app.mount({})
    // SAFETY: These are the component setup bindings exposed by Vue's test renderer.
    const state = (instance.$ as unknown as { setupState: { active?: ConsoleMediaFile, client: ConsoleBlobMediaClient } }).setupState
    await vi.waitFor(() => expect(state.active?.pathname).toBe("images/selected.png"))
    const previous = state.client
    resolveGrant?.(true)
    await vi.waitFor(() => {
      expect(state.client).not.toBe(previous)
      expect(state.client.object("images/selected.png")).toMatchObject({ contentType: "image/png", httpEtag: "selected-etag", customMetadata: { alt: "Selected" } })
    })
    expect(mocks.request).toHaveBeenCalledTimes(2)
  }
  finally {
    app.unmount()
  }
})
