// @vitest-environment happy-dom
import { Window } from "happy-dom"
import { createApp, defineComponent, h, type Component } from "vue"
import { describe, expect, it, vi } from "vitest"

import { ConsoleRequestError } from "../src/console/runtime/client/request"
import ConsoleState from "../src/console/runtime/components/console-state.vue"

const UButton = defineComponent({
  props: { label: String, onClick: Function, target: String, to: String },
  setup(props) {
    return () => props.to
      ? h("a", { "data-button": props.label, href: props.to, target: props.target }, props.label)
      : h("button", { "data-button": props.label, onClick: props.onClick }, props.label)
  },
})
const UIcon = defineComponent({ props: { name: String }, setup: props => () => h("span", { "data-icon": props.name }) })
const UTooltip = defineComponent({ setup: (_props, { slots }) => () => slots.default?.() })

function render(props: Record<string, unknown>) {
  const root = new Window().document.createElement("div")
  const app = createApp(ConsoleState as Component, props)
  app.component("UButton", UButton).component("UIcon", UIcon).component("UTooltip", UTooltip)
  app.mount(root)
  const buttons = [...root.querySelectorAll("[data-button]")].map(button => button.getAttribute("data-button"))
  return { app, buttons, root }
}

describe("Console state", () => {
  it("shows the Connections 403 without a dead-end retry", () => {
    const retry = vi.fn()
    const { app, buttons, root } = render({
      error: new ConsoleRequestError(403, {
        code: "CONSOLE_MANAGER_REQUIRED",
        message: "The Console accepted this request, but the session has no user id.",
      }),
      retry,
      title: "Could not load Connections",
    })
    try {
      expect(root.querySelector("[role=alert]")).not.toBeNull()
      expect(root.textContent).toContain("Could not load Connections")
      expect(root.textContent).toContain("the session has no user id")
      expect(root.textContent).toContain("Sign out and sign in again.")
      expect(root.textContent).toContain("CONSOLE_MANAGER_REQUIRED · 403")
      expect(buttons).toEqual(["Read the docs"])
      expect(root.querySelector("a")?.getAttribute("href")).toBe("https://vitehub.dev/docs/connections/server-api#management-routes")
    }
    finally { app.unmount() }
  })

  it("asks to sign in again for a 401", () => {
    const { app, buttons } = render({ error: new ConsoleRequestError(401), retry: vi.fn(), title: "Could not load Env" })
    try {
      expect(buttons).toEqual(["Sign in again", "Read the docs"])
    }
    finally { app.unmount() }
  })

  it("offers a retry only for a transient failure with a retry handler", () => {
    const retry = vi.fn()
    const transient = render({ error: new ConsoleRequestError(503), retry, title: "Could not load keys" })
    const withoutHandler = render({ error: new ConsoleRequestError(503), title: "Could not load keys" })
    try {
      expect(transient.buttons).toEqual(["Try again", "Read the docs"])
      const view = transient.root.ownerDocument.defaultView
      if (!view) throw new TypeError("Expected a happy-dom window.")
      transient.root.querySelector("[data-button='Try again']")?.dispatchEvent(new view.MouseEvent("click"))
      expect(retry).toHaveBeenCalledOnce()
      expect(withoutHandler.buttons).toEqual(["Read the docs"])
    }
    finally {
      transient.app.unmount()
      withoutHandler.app.unmount()
    }
  })

  it("links the setup guide of the section in an empty state", () => {
    const { app, buttons, root } = render({ description: "Add a Connection Definition.", section: "connections", title: "No Connections yet" })
    try {
      expect(root.querySelector("[role=status]")).not.toBeNull()
      expect(root.textContent).toContain("Add a Connection Definition.")
      expect(buttons).toEqual(["Get started"])
      expect(root.querySelector("a")?.getAttribute("href")).toBe("https://vitehub.dev/docs/connections/get-started")
    }
    finally { app.unmount() }
  })
})
