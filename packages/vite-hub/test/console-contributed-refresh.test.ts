import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

import { expect, it } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"

import { consoleSectionRouteName, describeConsoleSectionRoutes } from "../src/console/runtime/sections"

it("replaces stored descriptors and document pages in the active route", async () => {
  const component = {}
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ name: "vitehub-console", path: "/", component }],
  })
  // Exercise the entry's route registration with the real router, without mounting the browser entry.
  const source = readFileSync(new URL("../src/console/runtime/client/main.js", import.meta.url), "utf8")
  const start = source.indexOf("const contributedRoutes")
  const end = source.indexOf("subscribeConsoleNavigation(sectionsBase, addContributedRoutes);")
  const addRoutes = runInNewContext(`${source.slice(start, end)}\naddContributedRoutes`, {
    router, consoleSectionRouteName, describeConsoleSectionRoutes,
    ConsoleAuth: component, ConsoleDocuments: component,
    ConsoleOperationView: component, ConsoleDefinitions: component, sectionsBase: "/sections",
  })
  const apply = (details: object) => addRoutes({ sections: ["inventory"], contributions: { inventory: details } })
  apply({ id: "inventory", label: "Inventory", view: { kind: "operation-view", operation: "inventory.old" } })
  await router.push("/inventory?sort=name")
  apply({ id: "inventory", label: "Inventory", view: { kind: "operation-view", operation: "inventory.new" } })
  // Await the replacement navigation scheduled by reconciliation.
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(router.currentRoute.value.fullPath).toBe("/inventory?sort=name")
  expect(router.currentRoute.value.matched[0]!.props.default).toMatchObject({
    details: { view: { operation: "inventory.new" } },
  })
  apply({ id: "inventory", label: "Inventory", view: { kind: "document-editor" }, pages: [{ id: "old", label: "Old" }] })
  await router.push("/inventory/-/old")
  apply({ id: "inventory", label: "Inventory", view: { kind: "document-editor" }, pages: [{ id: "new", label: "New" }] })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(router.hasRoute("vitehub-console-inventory--old")).toBe(false)
  expect(router.resolve("/inventory/-/new").meta.consolePage).toBe("new")
  expect(router.currentRoute.value.name).toBe("vitehub-console")
})
