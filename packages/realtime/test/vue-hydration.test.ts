// @vitest-environment happy-dom
import { createSSRApp, defineComponent, h, nextTick, ref } from "vue"
import { renderToString } from "vue/server-renderer"
import { afterEach, expect, it, vi } from "vitest"

import { useRealtimeTiptap } from "../src/vue.ts"

vi.mock("@vite-hub/auth/vue", () => ({
  useUserSession: () => ({ user: ref(null) }),
}))

const providers = vi.hoisted(() => [] as Array<{ statusHandler?: (event: { status: string }) => void }>)

vi.mock("y-websocket", () => ({
  WebsocketProvider: class {
    awareness = { getStates: () => new Map(), off: vi.fn(), on: vi.fn(), setLocalState: vi.fn(), setLocalStateField: vi.fn() }
    connect = vi.fn()
    destroy = vi.fn()
    disconnect = vi.fn()
    messageHandlers = []
    on = vi.fn((event: string, handler: (event: { status: string }) => void) => {
      if (event === "status") this.statusHandler = handler
    })
    params: Record<string, string> = {}
    statusHandler?: (event: { status: string }) => void
    ws = { OPEN: 1, readyState: 1, send: vi.fn() }
    wsconnected = false
    constructor(_server: string, _room: string, public doc: { destroy: () => void }) { providers.push(this) }
  },
}))

afterEach(() => {
  providers.length = 0
  document.body.innerHTML = ""
  vi.restoreAllMocks()
})

it("hydrates the status that the server rendered, then connects after mount", async () => {
  const App = defineComponent({
    setup() {
      const { status } = useRealtimeTiptap("docs", "guides/a.md")
      return () => h("p", `Realtime: ${status.value}`)
    },
  })
  const browserWindow = globalThis.window
  vi.stubGlobal("window", undefined)
  const html = await renderToString(createSSRApp(App))
  vi.stubGlobal("window", browserWindow)
  expect(html).toBe("<p>Realtime: disconnected</p>")

  const container = document.createElement("div")
  container.innerHTML = html
  document.body.append(container)
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const app = createSSRApp(App)
  app.mount(container)
  expect(warn.mock.calls.flat().map(String).filter(line => /hydration/i.test(line))).toEqual([])

  await nextTick()
  expect(container.textContent).toBe("Realtime: connecting")
  providers.at(-1)?.statusHandler?.({ status: "connected" })
  await nextTick()
  expect(container.textContent).toBe("Realtime: connected")
  app.unmount()
  vi.unstubAllGlobals()
})
