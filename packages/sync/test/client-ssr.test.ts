import { describe, expect, it, vi } from "vitest"

import { createSSRApp, defineComponent, h } from "vue"
import { renderToString } from "vue/server-renderer"

import { clearSync, createSync } from "../src/client.ts"
import { useSync } from "../src/vue.ts"

describe("createSync on the server", () => {
  it("makes no request, starts no timer, and has no rows", async () => {
    expect("window" in globalThis).toBe(false)
    const fetch = vi.fn<typeof globalThis.fetch>()
    const timer = vi.spyOn(globalThis, "setTimeout")
    const store = createSync("todos", { fetch, interval: 1000 })
    await store.refresh()
    expect(store.getState()).toEqual({ rows: [], status: "idle", error: null, queued: 0, failures: [], persisted: false, live: false })
    expect(store.pending("a")).toBe(false)
    expect(() => store.actions.complete({ id: "a" })).toThrow("browser")
    expect(store.get("a")).toBeUndefined()
    expect(() => store.insert({ title: "Milk" })).toThrow("browser")
    await clearSync()
    expect(fetch).not.toHaveBeenCalled()
    expect(timer).not.toHaveBeenCalled()
    store.destroy()
    timer.mockRestore()
  })
})

describe("useSync on the server", () => {
  it("renders an empty list without a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const Todos = defineComponent({
      setup() {
        const todos = useSync("todos", { fetch })
        return () => h("ul", { "data-status": todos.status }, todos.rows.map(todo => h("li", String(todo.title))))
      },
    })
    expect(await renderToString(createSSRApp(Todos))).toBe(`<ul data-status="idle"></ul>`)
    expect(fetch).not.toHaveBeenCalled()
  })
})
