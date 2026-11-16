import { createRenderer, nextTick, reactive, ssrContextKey } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ push: vi.fn(), shortcuts: vi.fn(), closeDrawer: vi.fn() }))
vi.mock("@nuxt/ui/composables", () => ({ defineShortcuts: mocks.shortcuts }))
vi.mock("@vite-hub/auth/vue", () => ({ createAuthClient: vi.fn() }))
const route = reactive({ name: "vitehub-console", params: {}, fullPath: "/" })
vi.mock("../src/console/runtime/client/sidebar", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/sidebar")>(),
  closeConsoleSidebarDrawer: mocks.closeDrawer,
}))
vi.mock("vue-router", () => ({
  useRoute: () => route,
  useRouter: () => ({ push: mocks.push }),
}))
vi.mock("../src/console/runtime/client/request", () => ({
  requestConsole: async () => ({ sections: ["agents", "kv"], auth: false }),
}))

import Rail from "../src/console/runtime/components/console-rail.vue"
import Sidebar from "../src/console/runtime/components/console-sidebar.vue"
import { consoleSidebarOpen, setConsoleSidebarOpen } from "../src/console/runtime/client/sidebar"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

// Only the DOM surface read by the rail is needed by the node renderer.
class EditingElement {
  constructor(readonly tagName: string, readonly isContentEditable = false) {}
  matches() { return ["INPUT", "TEXTAREA"].includes(this.tagName) }
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe("Console Go to chord focus", () => {
  it.each([
    new EditingElement("INPUT"),
    new EditingElement("TEXTAREA"),
    new EditingElement("DIV", true),
    new EditingElement("SPAN", true), // A child inherits contenteditable from its parent.
  ])("rejects chords that start in or cross an editor: %o", async (editor) => {
    const target = new EventTarget()
    const document = { activeElement: new EditingElement("BODY") }
    vi.stubGlobal("window", target)
    vi.stubGlobal("document", document)
    vi.stubGlobal("HTMLElement", EditingElement)
    const app = renderer.createApp({ ...Rail, render: () => null }, { sectionsBase: "/sections" })
    app.provide(ssrContextKey, {})
    app.mount({})
    await nextTick()
    await nextTick()
    mocks.closeDrawer.mockClear()
    route.fullPath = "/auth"
    await nextTick()
    route.fullPath = "/" // Browser Back updates the route without calling the rail navigation helper.
    await nextTick()
    expect(mocks.closeDrawer).toHaveBeenCalledTimes(2)
    // Model Nuxt UI's matching boundary: it can invoke a matched g-a handler even
    // when g was typed in an editor. The rail must reject that callback itself.
    const shortcuts = mocks.shortcuts.mock.calls[0]![0] as { value: Record<string, () => void> }
    function key(key: string) {
      target.dispatchEvent(Object.assign(new Event("keydown"), { key }))
    }
    function focus(element: EditingElement) {
      document.activeElement = element
      target.dispatchEvent(new Event("focusin"))
    }
    const body = document.activeElement
    try {
      expect(Object.keys(shortcuts.value).sort()).toEqual(["g-a", "g-k", "g-o"])
      focus(editor)
      key("g")
      focus(body)
      key("a")
      shortcuts.value["g-a"]!()
      expect(mocks.push).not.toHaveBeenCalled()

      key("g")
      focus(editor)
      focus(body)
      key("a")
      shortcuts.value["g-a"]!()
      expect(mocks.push).not.toHaveBeenCalled()

      focus(editor)
      key("g")
      key("a")
      shortcuts.value["g-a"]!()
      expect(mocks.push).not.toHaveBeenCalled()

      focus(body)
      key("g")
      key("a")
      shortcuts.value["g-a"]!()
      expect(mocks.push).toHaveBeenCalledExactlyOnceWith({ name: "vitehub-console-agents" })
      key("g")
      key("o")
      shortcuts.value["g-o"]!()
      expect(mocks.push).toHaveBeenLastCalledWith({ name: "vitehub-console" })
    }
    finally { app.unmount() }
  })
})

it("registers the sidebar toggle in the shared shell for app and team pages", () => {
  vi.stubGlobal("document", new EventTarget())
  vi.stubGlobal("requestAnimationFrame", vi.fn())
  setConsoleSidebarOpen(false)
  const app = renderer.createApp({ ...Sidebar, render: () => null }, { homeHref: "/", homeLabel: "Apps", search: false })
  app.provide(ssrContextKey, {})
  app.mount({})
  try {
    expect(mocks.shortcuts).toHaveBeenCalledTimes(1)
    const shortcuts = mocks.shortcuts.mock.calls[0]![0] as Record<string, () => void>
    expect(Object.keys(shortcuts)).toEqual(["["])
    shortcuts["["]!()
    expect(consoleSidebarOpen.value).toBe(true)
    shortcuts["["]!()
    expect(consoleSidebarOpen.value).toBe(false)
  }
  finally { app.unmount(); setConsoleSidebarOpen(false) }
})
