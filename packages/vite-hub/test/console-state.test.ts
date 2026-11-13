// @vitest-environment happy-dom
import { Window } from "happy-dom"
import { createApp, defineComponent, h, type Component } from "vue"
import { describe, expect, it, vi } from "vitest"

import { ConsoleRequestError } from "../src/console/runtime/client/request"
import ConsoleState from "../src/console/runtime/components/console-state.vue"

const UButton = defineComponent({
  props: { label: String, onClick: Function, target: String, to: String },
  setup(props, { slots }) {
    return () => props.to
      ? h("a", { "data-button": props.label, href: props.to, target: props.target }, props.label)
      : h("button", { "data-button": props.label, onClick: props.onClick }, props.label ?? slots.default?.())
  },
})
// UEmpty as ConsoleState uses it: the title, the description, and the body.
const UEmpty = defineComponent({
  props: { description: String, title: String },
  setup: (props, { attrs, slots }) => () => h("div", attrs, [h("h2", props.title), slots.description?.() ?? props.description, slots.body?.(), slots.actions?.()]),
})
// UAlert as the compact state uses it: the title, the description, and the actions.
const UAlert = defineComponent({
  props: { description: String, title: String },
  setup: (props, { attrs, slots }) => () => h("div", attrs, [h("h2", props.title), slots.description?.() ?? props.description, slots.actions?.()]),
})
const UIcon = defineComponent({ props: { name: String }, setup: props => () => h("span", { "data-icon": props.name }) })
const UTooltip = defineComponent({ setup: (_props, { slots }) => () => slots.default?.() })

function render(props: Record<string, unknown>) {
  const root = new Window().document.createElement("div")
  const app = createApp(ConsoleState as Component, props)
  app.component("UAlert", UAlert).component("UButton", UButton).component("UEmpty", UEmpty).component("UIcon", UIcon).component("UTooltip", UTooltip)
  app.mount(root)
  const buttons = [...root.querySelectorAll("[data-button]")].map(button => button.getAttribute("data-button"))
  return { app, buttons, root }
}

describe("Console state", () => {
  it("shows a 403 without a dead-end retry", () => {
    const retry = vi.fn()
    const { app, buttons, root } = render({
      error: new ConsoleRequestError(403, {
        code: "CONSOLE_ACCESS_DENIED",
        message: "The Console access policy rejected this account.",
      }),
      retry,
      title: "Could not load Agents",
    })
    try {
      expect(root.querySelector("[role=alert]")).not.toBeNull()
      expect(root.textContent).toContain("Could not load Agents")
      expect(root.textContent).toContain("rejected this account")
      expect(root.textContent).toContain("ask the Console owner for access")
      expect(root.textContent).toContain("CONSOLE_ACCESS_DENIED · 403")
      expect(buttons).toEqual(["Read the docs"])
      expect(root.querySelector("a")?.getAttribute("href")).toBe("https://vitehub.dev/docs/development/console#how-each-mode-checks-a-request")
    }
    finally { app.unmount() }
  })

  it("asks to sign in again for a 401", () => {
    const { app, buttons, root } = render({ error: new ConsoleRequestError(401), retry: vi.fn(), title: "Could not load Env" })
    try {
      expect(buttons).toEqual(["Sign in again", "Read the docs"])
      // The fix "Sign in again." only repeats the button, so the state shows the button alone.
      expect([...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)).toEqual(["You are not signed in, or your session ended."])
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

  it("keeps the compact actions short enough for one sidebar row", () => {
    const { app, buttons, root } = render({ compact: true, error: new ConsoleRequestError(500), retry: vi.fn(), title: "Could not load Agents" })
    try {
      expect(buttons).toEqual(["Try again", "Docs"])
      expect(root.textContent).toContain("· 500")
    }
    finally { app.unmount() }
  })

  it("links the setup guide of the section in an empty state", () => {
    const { app, buttons, root } = render({ description: "Add a KV store.", section: "kv", title: "No keys yet" })
    try {
      expect(root.querySelector("[role=status]")).not.toBeNull()
      expect(root.textContent).toContain("Add a KV store.")
      expect(buttons).toEqual(["Get started"])
      expect(root.querySelector("a")?.getAttribute("href")).toBe("https://vitehub.dev/docs/kv/get-started")
    }
    finally { app.unmount() }
  })
})
