import { afterEach, expect, it, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"

import { consolePendingSectionRoute, resolveConsoleSectionDeepLink } from "../src/console/runtime/client/sections"

const empty = { render: () => null }

function consoleRouter() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [consolePendingSectionRoute, { component: empty, name: "vitehub-console", path: "/" }],
  })
  // The navigation response arrives after the first navigation starts, like on a deep link.
  router.beforeEach(to => resolveConsoleSectionDeepLink(router, to, async () => {
    await new Promise(resolve => setTimeout(resolve, 1))
    if (!router.hasRoute("vitehub-console-queues")) router.addRoute({ component: empty, name: "vitehub-console-queues", path: "/queues" })
  }))
  return router
}

afterEach(() => vi.restoreAllMocks())

it("opens a contributed section deep link without a Vue Router warning", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const router = consoleRouter()

  await router.push("/queues?view=all")

  expect(router.currentRoute.value.name).toBe("vitehub-console-queues")
  expect(router.currentRoute.value.fullPath).toBe("/queues?view=all")
  expect(warn).not.toHaveBeenCalled()
})

it("sends a path that stays unknown after the navigation loads to the Overview", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const router = consoleRouter()

  await router.push("/not-a-section")

  expect(router.currentRoute.value.name).toBe("vitehub-console")
  expect(warn).not.toHaveBeenCalled()
})
