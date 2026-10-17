import { createMemoryHistory, createRouter } from "vue-router"
import { describe, expect, it } from "vitest"

import { describeConsoleContributedSections } from "../src/console/contributions.ts"
import { resolveConsoleRouteName } from "../src/console/runtime/console-route.ts"
import { parseConsoleContributedSection } from "../src/console/runtime/definitions.ts"
import { consoleSectionPageRouteName, describeConsoleSectionRoutes } from "../src/console/runtime/sections.ts"

const content = describeConsoleContributedSections(["content", "blob"])[0]!

function router() {
  const component = {}
  const routes = describeConsoleSectionRoutes(content).map(route => route.redirect
    ? { name: route.name, path: route.path, redirect: route.redirect }
    : { component, meta: { consolePage: route.page }, name: route.name, path: route.path })
  return createRouter({ history: createMemoryHistory(), routes })
}

describe("Console section pages", () => {
  it("describes the routes of the Content dashboard, its pages, and its collections", () => {
    expect(describeConsoleSectionRoutes(content)).toEqual([
      { name: "vitehub-console-content--dashboard", path: "/content/-/dashboard", redirect: "/content" },
      { name: "vitehub-console-content--settings", page: "settings", path: "/content/-/settings" },
      { name: "vitehub-console-content--media", page: "media", path: "/content/-/media" },
      { name: "vitehub-console-content", path: "/content/:collection?/:document(.*)*" },
    ])
    // Sections without pages keep one route.
    expect(describeConsoleSectionRoutes({ id: "queues", view: { kind: "definition-catalog" } })).toEqual([{ name: "vitehub-console-queues", path: "/queues" }])
  })

  it("resolves deep links without page and collection segments colliding", () => {
    const routes = router()
    const resolve = (path: string) => {
      const route = routes.resolve(path)
      return { name: route.name, page: route.meta.consolePage, params: route.params }
    }
    // The section root serves the index page: the dashboard.
    expect(resolve("/content")).toEqual({ name: "vitehub-console-content", page: undefined, params: {} })
    expect(resolve("/content/-/media")).toEqual({ name: "vitehub-console-content--media", page: "media", params: {} })
    expect(resolve("/content/posts")).toMatchObject({ name: "vitehub-console-content", params: { collection: "posts" } })
    expect(resolve("/content/posts/2026/autumn")).toMatchObject({ name: "vitehub-console-content", params: { collection: "posts", document: ["2026", "autumn"] } })
    // A collection named like a page stays a collection; an unknown page reaches the main view as collection `-`.
    expect(resolve("/content/media")).toMatchObject({ name: "vitehub-console-content", params: { collection: "media" } })
    expect(resolve("/content/-/calendar")).toMatchObject({ name: "vitehub-console-content", params: { collection: "-", document: ["calendar"] } })
    expect(routes.resolve({ name: "vitehub-console-content--media" }).href).toBe("/content/-/media")
  })

  it("redirects the path of the index page to the section root", async () => {
    const routes = router()
    await routes.push("/content/-/dashboard")
    expect(routes.currentRoute.value.fullPath).toBe("/content")
  })

  it("keeps a host suffix when a page route opens another section", () => {
    expect(consoleSectionPageRouteName("content", "media")).toBe("vitehub-console-content--media")
    expect(resolveConsoleRouteName("vitehub-console-content--media___en", "vitehub-console-agents")).toBe("vitehub-console-agents___en")
    expect(resolveConsoleRouteName("vitehub-console-content--media", "vitehub-console-content")).toBe("vitehub-console-content")
  })

  it("shows Media only when the project enables Blob", () => {
    expect(describeConsoleContributedSections(["content"])[0]?.pages?.map(page => page.id)).toEqual(["dashboard", "settings"])
    expect(content.pages?.map(page => page.id)).toEqual(["dashboard", "settings", "media"])
    // The client never receives `requires`.
    expect(JSON.stringify(content)).not.toContain("requires")
  })

  it("reads pages from untrusted navigation JSON", () => {
    const parsed = parseConsoleContributedSection({
      ...content,
      pages: [
        { id: "dashboard", label: "Dashboard", icon: "i-lucide-layout-dashboard", index: true, view: { kind: "document-dashboard" } },
        { id: "dashboard", label: "Again", icon: "i-lucide-x", view: { kind: "document-dashboard" } },
        { id: "calendar", label: "Calendar", icon: "i-lucide-calendar", view: { kind: "calendar" } },
        { id: "Bad", label: "Bad", icon: "i-lucide-x", view: { kind: "media-library" } },
        { id: "settings", label: "Settings", icon: "i-lucide-settings-2", group: "Site", view: { kind: "document-settings" } },
        { id: "media", label: "Media", icon: "i-lucide-image", index: true, group: " Assets ", view: { kind: "media-library" } },
      ],
    })
    expect(parsed?.pages).toEqual([
      { icon: "i-lucide-layout-dashboard", id: "dashboard", index: true, label: "Dashboard", view: { kind: "document-dashboard" } },
      { group: "Site", icon: "i-lucide-settings-2", id: "settings", label: "Settings", view: { kind: "document-settings" } },
      { group: "Assets", icon: "i-lucide-image", id: "media", label: "Media", view: { kind: "media-library" } },
    ])
    expect(parseConsoleContributedSection({ ...content, pages: "x" })).not.toHaveProperty("pages")
  })
})
