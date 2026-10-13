// @vitest-environment happy-dom
import { Window } from "happy-dom"
import { createApp, defineComponent, h } from "vue"
import { describe, expect, it } from "vitest"

import SectionIcon from "../src/console/runtime/components/console-section-icon.vue"
import { consoleSectionRailIcons } from "../src/console/runtime/sections"

function render(section: string, icon: string) {
  const root = new Window().document.createElement("div")
  const app = createApp(SectionIcon, { class: "size-4", icon, section })
  app.component("UIcon", defineComponent({
    props: { name: { required: true, type: String } },
    setup(props) { return () => h("span", { "data-icon-name": props.name }) },
  }))
  app.mount(root)
  return { app, root }
}

describe("Console section icon", () => {
  it.each(Object.entries(consoleSectionRailIcons))("renders the shared rail icon for %s", (section, railIcon) => {
    const { app, root } = render(section, "i-ph-tray-light")
    try {
      const icon = root.querySelector("svg")
      expect(icon?.getAttribute("data-icon")).toBe(railIcon)
      expect(icon?.getAttribute("aria-hidden")).toBe("true")
      expect(icon?.classList.contains("size-4")).toBe(true)
      expect(root.querySelector("[data-icon-name]")).toBeNull()
    }
    finally { app.unmount() }
  })

  it("keeps the descriptor icon of an unknown contributed section", () => {
    const { app, root } = render("custom", "i-lucide-sparkles")
    try {
      expect(root.querySelector("svg")).toBeNull()
      expect(root.querySelector("[data-icon-name]")?.getAttribute("data-icon-name")).toBe("i-lucide-sparkles")
    }
    finally { app.unmount() }
  })
})
