// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, createSSRApp, defineComponent, h, nextTick, ref } from "vue"
import { renderToString } from "vue/server-renderer"

import { clearSync } from "../src/client.ts"
import { useSync } from "../src/vue.ts"
import { createFakeSyncServer } from "./client-fake-server.ts"
import { until } from "./client-harness.ts"

import type { FakeSyncServer } from "./client-fake-server.ts"

afterEach(async () => {
  document.body.innerHTML = ""
  await clearSync()
})

function mountTodos(server: FakeSyncServer) {
  let todos!: ReturnType<typeof useSync<"todos">>
  const Todos = defineComponent({
    setup() {
      todos = useSync("todos", { fetch: server.fetch, interval: false })
      return () => h("div", [
        h("ul", todos.rows.map(todo => h("li", { key: String(todo.id) }, String(todo.title)))),
        h("p", { id: "status" }, `${todos.status} ${todos.queued}`),
      ])
    },
  })
  const root = document.createElement("div")
  document.body.append(root)
  const app = createApp(Todos)
  app.mount(root)
  return { app, root, todos: () => todos }
}

describe("useSync", () => {
  it("renders the rows and updates after a write", async () => {
    const server = createFakeSyncServer()
    server.write({ id: "a", ownerId: "ada", title: "Milk" })
    const { app, root, todos } = mountTodos(server)
    await until(() => root.querySelectorAll("li").length === 1)
    expect(root.querySelector("#status")!.textContent).toBe("ready 0")
    const write = todos().insert({ title: "Eggs" })
    expect(todos().rows.length).toBe(2)
    await nextTick()
    expect([...root.querySelectorAll("li")].map(item => item.textContent)).toEqual(["Milk", "Eggs"])
    expect(root.querySelector("#status")!.textContent).toBe("ready 1")
    await write
    await nextTick()
    expect(root.querySelector("#status")!.textContent).toBe("ready 0")
    expect(todos().get(write.key)).toMatchObject({ title: "Eggs", ownerId: "ada" })
    app.unmount()
  })

  it("shares one store between components and stops it with the last one", async () => {
    const server = createFakeSyncServer()
    const one = mountTodos(server)
    const two = mountTodos(server)
    await until(() => one.todos().status === "ready" && two.todos().status === "ready")
    expect(server.requests.filter(request => !request.url.searchParams.has("live")).length).toBe(1)
    await one.todos().insert({ title: "Milk" })
    await nextTick()
    expect(two.root.querySelectorAll("li").length).toBe(1)
    one.app.unmount()
    two.app.unmount()
    const requests = server.requests.length
    document.dispatchEvent(new Event("visibilitychange"))
    window.dispatchEvent(new Event("online"))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(server.requests.length).toBe(requests)
  })

  it("hydrates server HTML without a mismatch", async () => {
    const server = createFakeSyncServer()
    server.write({ id: "a", ownerId: "ada", title: "Milk" })
    const Todos = defineComponent({
      setup() {
        const todos = useSync("todos", { fetch: server.fetch, interval: false })
        return () => h("div", [
          h("p", `${todos.status} ${todos.persisted}`),
          h("ul", todos.rows.map(todo => h("li", { key: String(todo.id) }, String(todo.title)))),
        ])
      },
    })
    vi.stubGlobal("window", undefined)
    const html = await renderToString(createSSRApp(Todos))
    vi.unstubAllGlobals()
    expect(server.requests).toEqual([])
    const root = document.createElement("div")
    root.innerHTML = html
    document.body.append(root)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const app = createSSRApp(Todos)
    app.mount(root)
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/[Hh]ydration/)
    warn.mockRestore()
    await until(() => root.querySelectorAll("li").length === 1)
    expect(root.querySelector("p")!.textContent).toBe("ready false")
    app.unmount()
  })

  it("moves to the store of a new subset, and stops the old one with its last user", async () => {
    const server = createFakeSyncServer()
    server.live = false
    server.write({ id: "a", ownerId: "ada", listId: "l1", title: "In l1" })
    server.write({ id: "b", ownerId: "ada", listId: "l2", title: "In l2" })
    const list = ref("l1")
    let todos!: ReturnType<typeof useSync<"todos">>
    const Todos = defineComponent({
      setup() {
        todos = useSync("todos", { fetch: server.fetch, interval: false, where: () => ({ listId: list.value }) })
        return () => h("ul", todos.rows.map(todo => h("li", { key: String(todo.id) }, String(todo.title))))
      },
    })
    const root = document.createElement("div")
    document.body.append(root)
    const app = createApp(Todos)
    app.mount(root)
    const titles = () => [...root.querySelectorAll("li")].map(item => item.textContent)
    await until(() => titles().join() === "In l1")
    list.value = "l2"
    await until(() => titles().join() === "In l2")
    const write = todos.insert({ title: "New in l2" })
    expect(todos.get(write.key)).toMatchObject({ listId: "l2" })
    await write
    const pulls = () => server.requests.filter(request => request.method === "GET" && !request.url.searchParams.has("live"))
    expect(pulls().map(request => request.url.searchParams.get("where"))).toEqual([`{"listId":"l1"}`, `{"listId":"l2"}`])
    // The store of l1 stopped, so it does not pull on events.
    const count = pulls().length
    window.dispatchEvent(new Event("online"))
    await until(() => pulls().length === count + 1)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(pulls().slice(count).map(request => request.url.searchParams.get("where"))).toEqual([`{"listId":"l2"}`])
    // A subset seen before shows from storage before its pull.
    server.offline = true
    list.value = "l1"
    await until(() => titles().join() === "In l1")
    expect(todos.status).toBe("offline")
    app.unmount()
  })

  it("shows pending rows, the live stream, and optimistic actions", async () => {
    const server = createFakeSyncServer()
    server.write({ id: "a", ownerId: "ada", title: "Milk", done: false })
    server.actions.complete = ({ update }, args) => update((args as { id: string }).id, { done: true })
    let todos!: ReturnType<typeof useSync<"todos">>
    const Todos = defineComponent({
      setup() {
        todos = useSync("todos", { fetch: server.fetch, interval: false, actions: { complete: (local, { id }) => local.update(id, { done: true }) } })
        return () => h("ul", todos.rows.map(todo => h("li", { key: String(todo.id), class: { pending: todos.pending(todo.id), done: todo.done } }, String(todo.title))))
      },
    })
    const root = document.createElement("div")
    document.body.append(root)
    const app = createApp(Todos)
    app.mount(root)
    await until(() => todos.live)
    const write = todos.actions.complete({ id: "a" })
    await nextTick()
    expect(root.querySelector("li")!.className).toBe("pending done")
    await write
    await nextTick()
    expect(root.querySelector("li")!.className).toBe("done")
    app.unmount()
  })
})

