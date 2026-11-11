// @vitest-environment happy-dom
import type { Window } from "happy-dom"
import * as v from "valibot"
import { describe, expect, it, vi } from "vitest"
import { createApp, h } from "vue"
import { createRouter, createWebHistory, RouterView } from "vue-router"

import { AutoForm } from "@vite-hub/forms/vue"

// SAFETY: This test runs in happy-dom, whose window is the global scope.
const { document, history, location } = globalThis as unknown as Pick<Window, "document" | "history" | "location">

describe("AutoForm result cleanup with Vue Router", () => {
  it.each([false, true])("waits for initial navigation and rechecks its result (redirected: %s)", async (redirected) => {
    history.replaceState(null, "", "/contact?plan=pro&form=contact.sent#top")
    const routerHistory = createWebHistory()
    const router = createRouter({ history: routerHistory, routes: [
      { path: "/", component: { render: () => null } },
      { path: "/contact", component: { render: () => h("h1", "Contact") } },
    ] })
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    router.beforeEach(async (to) => {
      await waiting
      if (redirected && to.query.form === "contact.sent") return { path: to.path, query: { ...to.query, form: "newsletter.sent" }, hash: to.hash }
    })
    const root = document.createElement("div")
    document.body.append(root)
    const app = createApp({ render: () => [h(RouterView), h(AutoForm, { name: "contact", schema: v.object({ message: v.string() }) })] })
    try {
      app.use(router).mount(root)
      expect(router.currentRoute.value.fullPath).toBe("/")
      release()
      await router.isReady()
      const expected = redirected ? "/contact?plan=pro&form=newsletter.sent#top" : "/contact?plan=pro#top"
      await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe(expected))
      expect(`${location.pathname}${location.search}${location.hash}`).toBe(expected)
      expect(root.querySelector("h1")?.textContent).toBe("Contact")
      expect(root.querySelector("[role=status]")?.textContent).toBe("Thanks. Your message was sent.")
    }
    finally {
      release()
      app.unmount()
      routerHistory.destroy()
      root.remove()
      history.replaceState(null, "", "/")
    }
  })
})
