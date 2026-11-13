// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { createApp, defineComponent, h, nextTick } from "vue"

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
    expect(server.requests.length).toBe(1)
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
})
