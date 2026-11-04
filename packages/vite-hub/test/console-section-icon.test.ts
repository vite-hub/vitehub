// @vitest-environment happy-dom
import { Window } from "happy-dom"
import { createApp, defineComponent, h } from "vue"
import { describe, expect, it } from "vitest"

import SectionIcon from "../src/console/runtime/components/console-section-icon.vue"
import { consolePrimitives } from "../src/console/runtime/sections"

function render(icon: string) {
  const root = new Window().document.createElement("div")
  const app = createApp(SectionIcon, { class: "size-4", icon })
  app.component("UIcon", defineComponent({
    props: { name: { required: true, type: String } },
    setup(props) { return () => h("span", { "data-icon-name": props.name }) },
  }))
  app.mount(root)
  return { app, root }
}

describe("Console section icon", () => {
  it.each(consolePrimitives.map(entry => [entry.id, entry.icon]))("renders the inline ViteHub icon for %s", (_section, name) => {
    const { app, root } = render(name)
    try {
      const icon = root.querySelector("svg")
      expect(icon?.getAttribute("data-icon")).toBe(name.replace(/^i-vitehub-/, ""))
      expect(icon?.getAttribute("aria-hidden")).toBe("true")
      expect(icon?.classList.contains("size-4")).toBe(true)
      expect(root.querySelector("[data-icon-name]")).toBeNull()
    }
    finally { app.unmount() }
  })

  it("keeps the descriptor icon of a contributed section outside the set", () => {
    const { app, root } = render("i-lucide-sparkles")
    try {
      expect(root.querySelector("svg")).toBeNull()
      expect(root.querySelector("[data-icon-name]")?.getAttribute("data-icon-name")).toBe("i-lucide-sparkles")
    }
    finally { app.unmount() }
  })
})
