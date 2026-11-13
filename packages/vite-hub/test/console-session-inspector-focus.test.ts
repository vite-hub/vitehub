// @vitest-environment happy-dom
import type { Window } from "happy-dom"
import { createApp, defineComponent, h, nextTick, ref, type Component } from "vue"
import { describe, expect, it, vi } from "vitest"

vi.mock("../src/console/runtime/client/request", () => ({ requestConsole: vi.fn() }))
vi.mock("@vite-hub/ui", () => ({ FileTree: {}, PatchDiff: {} }))
vi.mock("../src/console/runtime/components/invocation", () => ({
  AgentCapabilityInspector: { render: () => null },
  AgentInvocationInspector: { render: () => null },
  invocationActivities: () => [],
}))
vi.mock("../src/console/runtime/components/console-session-code-preview.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-session-trace.vue", () => ({ default: { render: () => null } }))

import Inspector from "../src/console/runtime/components/console-session-inspector.vue"

// SAFETY: This test runs in happy-dom, whose window is the global scope.
const { document } = globalThis as unknown as Pick<Window, "document">

const UButton = defineComponent({
  inheritAttrs: false,
  setup: (_props, { attrs, slots }) => () => h("button", { ...attrs, type: "button" }, slots.default?.() ?? String(attrs.label ?? "")),
})
const Slot = defineComponent({ setup: (_props, { slots }) => () => slots.default?.() })
const Empty = defineComponent({ render: () => null })
const UEmpty = defineComponent({ setup: (_props, { slots }) => () => h("div", slots.body?.()) })

async function mount(initial: { activeSurface: string; openViews: string[]; tab: string } = { activeSurface: "", openViews: [], tab: "details" }) {
  const root = document.createElement("div")
  document.body.append(root)
  const host = defineComponent({
    setup() {
      const activeSurface = ref(initial.activeSurface)
      const openViews = ref(initial.openViews)
      const tab = ref(initial.tab)
      return () => h(Inspector as Component, {
        "activeSurface": activeSurface.value,
        "invocation": { id: "run" },
        "openViews": openViews.value,
        "tab": tab.value,
        "onUpdate:activeSurface": (value: string) => (activeSurface.value = value),
        "onUpdate:openViews": (value: string[]) => (openViews.value = value),
        "onUpdate:tab": (value: string) => (tab.value = value),
      })
    },
  })
  const app = createApp(host)
  app.component("UButton", UButton).component("UTooltip", Slot).component("UDropdownMenu", Slot)
  app.component("UEmpty", UEmpty)
  for (const name of ["UIcon", "UKbd", "UTabs"]) app.component(name, Empty)
  app.mount(root)
  await nextTick()
  return { app, root }
}

const settle = async () => {
  for (let index = 0; index < 4; index++) await nextTick()
}

describe("Console inspector focus", () => {
  it("opens the Details tab when the panel has no open tab", async () => {
    const { app, root } = await mount()
    try {
      await settle()
      const tabs = [...root.querySelectorAll("[role='tab']")].map(tab => tab.textContent)
      expect(tabs).toEqual([expect.stringContaining("Details")])
      expect(root.textContent).not.toContain("Open a tab")
    }
    finally {
      app.unmount()
      root.remove()
    }
  })

  it("moves focus to the next tab when the focused tab closes", async () => {
    const { app, root } = await mount({ activeSurface: "view:trace", openViews: ["details", "trace"], tab: "trace" })
    try {
      const close = [...root.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === "Close Trace")!
      close.focus()
      close.click()
      await settle()
      expect(root.querySelector("[aria-label='Close Trace']")).toBeNull()
      expect(document.activeElement?.getAttribute("role")).toBe("tab")
      expect(document.activeElement?.textContent).toContain("Details")
    }
    finally {
      app.unmount()
      root.remove()
    }
  })
})
