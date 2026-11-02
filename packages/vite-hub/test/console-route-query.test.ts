import { createRenderer, defineComponent, nextTick } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { describe, expect, it, vi } from "vitest"

import {
  queryChoice,
  queryFlag,
  queryInteger,
  querySelection,
  queryText,
  readConsoleQuery,
  useConsoleQuery,
  writeConsoleQuery,
} from "../src/console/runtime/client/route-query"

import type { Ref } from "vue"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

const params = {
  level: queryChoice(["all", "warn", "error"], "all"),
  offset: queryInteger(0, { history: "push" }),
  open: queryFlag(),
  q: queryText(),
  row: querySelection(),
}

describe("Console query parameters", () => {
  it("reads missing and invalid values as their defaults", () => {
    expect(readConsoleQuery(params, {})).toEqual({ level: "all", offset: 0, open: false, q: "", row: undefined })
    expect(readConsoleQuery(params, { level: "loud", offset: "-5", open: "yes", q: ["", "b"], row: null })).toEqual({ level: "all", offset: 0, open: false, q: "", row: undefined })
    expect(readConsoleQuery(params, { offset: "1.5" }).offset).toBe(0)
    expect(readConsoleQuery(params, { offset: "9007199254740993" }).offset).toBe(0)
    expect(readConsoleQuery(params, { level: "warn", offset: "50", open: "1", q: ["boom", "other"], row: "r1" })).toEqual({ level: "warn", offset: 50, open: true, q: "boom", row: "r1" })
  })

  it("leaves defaults out of the URL and keeps parameters of other parts", () => {
    expect(writeConsoleQuery(params, { level: "all", offset: 0, open: false, q: "  ", row: undefined }, { embed: "1", level: "warn", q: "old" })).toEqual({ embed: "1" })
    expect(writeConsoleQuery(params, { level: "error", offset: 25, open: true, q: " boom ", row: "r1" }, {})).toEqual({ level: "error", offset: "25", open: "1", q: "boom", row: "r1" })
    expect(writeConsoleQuery(params, { q: "boom" }, { level: "warn" })).toEqual({ level: "warn", q: "boom" })
  })
})

async function mount(path: string, options: { onRestore?: (names: string[]) => void } = {}, previous?: string) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ component: {}, name: "page", path: "/page" }, { component: {}, name: "other", path: "/other" }] })
  if (previous) await router.push(previous)
  await router.push(path)
  const push = vi.spyOn(router, "push")
  const replace = vi.spyOn(router, "replace")
  let state!: { [K in keyof typeof params]: Ref<ReturnType<typeof readConsoleQuery<typeof params>>[K]> }
  const app = renderer.createApp(defineComponent({
    setup() {
      state = useConsoleQuery(params, options)
      return () => null
    },
  }))
  app.use(router)
  app.mount({})
  return { app, push, replace, router, state }
}

describe("useConsoleQuery", () => {
  it("restores the state of the URL", async () => {
    const { app, state } = await mount("/page?q=boom&level=error&offset=50&open=1&row=r1&embed=1")
    expect(state.q.value).toBe("boom")
    expect(state.level.value).toBe("error")
    expect(state.offset.value).toBe(50)
    expect(state.open.value).toBe(true)
    expect(state.row.value).toBe("r1")
    app.unmount()
  })

  it("replaces the entry for search and filters, and pushes one for selections and pages", async () => {
    const { app, push, replace, router, state } = await mount("/page?embed=1")
    state.q.value = "b"
    state.q.value = "bo"
    state.q.value = "boo "
    await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({ embed: "1", q: "boo" }))
    expect(replace).toHaveBeenCalledTimes(3)
    expect(push).not.toHaveBeenCalled()
    // Spaces that do not change the URL do not navigate, and stay in the input.
    state.q.value = "boo  "
    expect(replace).toHaveBeenCalledTimes(3)
    state.row.value = "r1"
    await vi.waitFor(() => expect(router.currentRoute.value.query.row).toBe("r1"))
    expect(push).toHaveBeenCalledExactlyOnceWith({ query: { embed: "1", q: "boo", row: "r1" } })
    state.offset.value = 25
    await vi.waitFor(() => expect(router.currentRoute.value.query.offset).toBe("25"))
    expect(push).toHaveBeenCalledTimes(2)
    expect(state.q.value).toBe("boo  ")
    app.unmount()
  })

  it("walks selections with Back and Forward and reports what changed", async () => {
    const restored: string[][] = []
    const { app, router, state } = await mount("/page", { onRestore: names => restored.push(names) })
    state.row.value = "r1"
    await vi.waitFor(() => expect(router.currentRoute.value.query.row).toBe("r1"))
    state.row.value = "r2"
    await vi.waitFor(() => expect(router.currentRoute.value.query.row).toBe("r2"))
    router.back()
    await vi.waitFor(() => expect(state.row.value).toBe("r1"))
    expect(restored).toEqual([["row"]])
    router.back()
    await vi.waitFor(() => expect(state.row.value).toBeUndefined())
    router.forward()
    await vi.waitFor(() => expect(state.row.value).toBe("r1"))
    app.unmount()
  })

  it("does not navigate for a value that the URL already holds", async () => {
    const { app, push, replace, state } = await mount("/page?level=warn")
    state.level.value = "warn"
    state.open.value = false
    await nextTick()
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    app.unmount()
  })

  it("restores multiple fields with Back and Forward without writing intermediate queries", async () => {
    const onRestore = vi.fn()
    const { app, push, replace, router, state } = await mount(
      "/page?offset=50&q=bob&row=r2", { onRestore }, "/page?offset=25&q=alice&row=r1",
    )
    try {
      router.back()
      await vi.waitFor(() => expect([state.offset.value, state.q.value, state.row.value]).toEqual([25, "alice", "r1"]))
      expect(router.currentRoute.value.query).toEqual({ offset: "25", q: "alice", row: "r1" })
      expect(onRestore).toHaveBeenLastCalledWith(["offset", "q", "row"])
      expect(push).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
      router.forward()
      await vi.waitFor(() => expect([state.offset.value, state.q.value, state.row.value]).toEqual([50, "bob", "r2"]))
      expect(router.currentRoute.value.query).toEqual({ offset: "50", q: "bob", row: "r2" })
      expect(push).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
    } finally {
      app.unmount()
    }
  })

  it("keeps the changes of two parts of a page that write in the same tick", async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ component: {}, name: "page", path: "/page" }] })
    await router.push("/page")
    const states: Array<ReturnType<typeof useConsoleQuery<{ a: ReturnType<typeof querySelection> }>>> = []
    const part = (name: string) => defineComponent({
      setup() {
        const state = useConsoleQuery({ [name]: querySelection() })
        states.push({ a: state[name]! })
        return () => null
      },
    })
    const first = renderer.createApp(part("first")).use(router)
    const second = renderer.createApp(part("second")).use(router)
    first.mount({})
    second.mount({})
    states[0]!.a.value = "1"
    states[1]!.a.value = "2"
    await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({ first: "1", second: "2" }))
    first.unmount()
    second.unmount()
  })

  it("stops following the URL on another route", async () => {
    const { app, router, state } = await mount("/page?q=boom")
    await router.push("/other?q=elsewhere")
    await nextTick()
    expect(state.q.value).toBe("boom")
    app.unmount()
  })

  it("keeps the state in the component without a router", () => {
    let state!: ReturnType<typeof useConsoleQuery<typeof params>>
    const app = renderer.createApp(defineComponent({
      setup() {
        state = useConsoleQuery(params)
        return () => null
      },
    }))
    app.mount({})
    expect(state.level.value).toBe("all")
    state.level.value = "warn"
    expect(state.level.value).toBe("warn")
    app.unmount()
  })
})
