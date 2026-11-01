// @vitest-environment happy-dom
import type { Window } from "happy-dom"
import { createApp, defineComponent, h, type Component } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/console/runtime/components/console-rail.vue", () => ({
  default: defineComponent({ setup: () => () => h("nav", [h("button", "Agents")]) }),
}))
vi.mock("../src/console/runtime/components/console-toaster.vue", () => ({ default: { render: () => null } }))
vi.mock("../src/console/runtime/components/console-loading.vue", () => ({ default: { render: () => null } }))

import App from "../src/console/runtime/client/app.vue"
import ConsoleFrame from "../src/console/runtime/components/console-frame.vue"
import ConsolePageHeader from "../src/console/runtime/components/console-page-header.vue"

// SAFETY: This test runs in happy-dom, whose window is the global scope.
const { document } = globalThis as unknown as Pick<Window, "document">

const passthrough = defineComponent({ setup: (_props, { slots }) => () => h("div", slots.default?.()) })
const navbar = defineComponent({ setup: (_props, { slots }) => () => h("header", slots.title?.()) })

async function mount(page: string | Component) {
  const root = document.createElement("div")
  document.body.append(root)
  const route = defineComponent({
    setup: () => () => h(ConsoleFrame, { sectionsBase: "/sections" }, () => typeof page === "string" ? h("div", { innerHTML: page }) : h(page)),
  })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: route }] })
  await router.push("/")
  const app = createApp(App as Component)
  app.use(router)
  app.component("UApp", passthrough)
  app.component("UDashboardGroup", passthrough)
  app.component("UDashboardNavbar", navbar)
  app.component("UButton", passthrough)
  app.mount(root)
  return { app, link: root.querySelector("a")!, root }
}

afterEach(() => document.body.replaceChildren())

describe("Console skip link", () => {
  it("is the first link and moves focus to the main landmark", async () => {
    const { app, link, root } = await mount(`<main><h1>Overview</h1></main>`)
    try {
      expect(link.textContent).toBe("Skip to content")
      expect(root.querySelector("a, button")).toBe(link)
      link.click()
      expect(document.activeElement?.tagName).toBe("MAIN")
      expect(document.activeElement?.getAttribute("tabindex")).toBe("-1")
    }
    finally { app.unmount() }
  })

  it("moves focus to the first heading on a page without a main landmark", async () => {
    const { app, link } = await mount(`<div><h1>Session</h1></div>`)
    try {
      link.click()
      expect(document.activeElement?.textContent).toBe("Session")
    }
    finally { app.unmount() }
  })

  it("skips the rail on a Blob-shaped page with a shared header and no main or h1", async () => {
    const page = defineComponent({
      setup: () => () => h("div", { id: "blob-objects" }, [
        h(ConsolePageHeader, { title: "Blob", toggle: false }),
        h("button", "Upload"),
      ]),
    })
    const { app, link, root } = await mount(page)
    try {
      expect(root.querySelector("main, h1")).toBeNull()
      expect(root.querySelector("header span")?.textContent).toContain("Blob")
      link.focus()
      link.click()
      expect(document.activeElement?.id).toBe("vitehub-console-content")
      expect(document.activeElement?.getAttribute("tabindex")).toBe("-1")
      expect(document.activeElement?.previousElementSibling?.tagName).toBe("NAV")
    }
    finally { app.unmount() }
  })
})
