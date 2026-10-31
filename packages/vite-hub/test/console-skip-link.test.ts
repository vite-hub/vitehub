// @vitest-environment happy-dom
import type { Window } from "happy-dom"
import { createApp, defineComponent, h, type Component } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("vue-router", () => ({
  RouterView: defineComponent({ setup: (_props, { slots }) => () => slots.default?.({ Component: undefined }) }),
}))
vi.mock("../src/console/runtime/components/console-loading.vue", () => ({ default: { render: () => null } }))

import App from "../src/console/runtime/client/app.vue"

// SAFETY: This test runs in happy-dom, whose window is the global scope.
const { document } = globalThis as unknown as Pick<Window, "document">

const UApp = defineComponent({ setup: (_props, { slots }) => () => h("div", { class: "vitehub-console" }, slots.default?.()) })

function mount(page: string) {
  const root = document.createElement("div")
  document.body.append(root)
  const app = createApp(App as Component)
  app.component("UApp", UApp)
  app.mount(root)
  root.querySelector(".vitehub-console")!.insertAdjacentHTML("beforeend", page)
  return { app, link: root.querySelector("a")!, root }
}

afterEach(() => document.body.replaceChildren())

describe("Console skip link", () => {
  it("is the first link and moves focus to the main landmark", () => {
    const { app, link, root } = mount(`<nav><button>Agents</button></nav><main><h1>Overview</h1></main>`)
    try {
      expect(link.textContent).toBe("Skip to content")
      expect(root.querySelector("a, button")).toBe(link)
      link.click()
      expect(document.activeElement?.tagName).toBe("MAIN")
      expect(document.activeElement?.getAttribute("tabindex")).toBe("-1")
    }
    finally { app.unmount() }
  })

  it("moves focus to the first heading on a page without a main landmark", () => {
    const { app, link } = mount(`<nav><button>Agents</button></nav><div><h1>Blob</h1></div>`)
    try {
      link.click()
      expect(document.activeElement?.textContent).toBe("Blob")
    }
    finally { app.unmount() }
  })
})
