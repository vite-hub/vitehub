import { createSSRApp, defineComponent, h } from "vue"
import { renderToString } from "vue/server-renderer"
import { describe, expect, it } from "vitest"
import History from "../src/console/runtime/components/console-workspace-history.vue"

import type { App } from "vue"

// Nuxt UI stand-ins that render the props a reader sees: labels, item labels, and link targets.
function stubs(app: App): void {
  app.component("UIcon", { props: { name: String }, template: "<span />" })
  app.component("UFormField", defineComponent({ props: { label: String }, setup: (props, { slots }) => () => h("label", [h("span", props.label), slots.default?.()]) }))
  app.component("USelect", { props: { items: Array, modelValue: String }, render(this: { items: Array<{ label: string, value: string }>, modelValue: string }) {
    return h("select", { value: this.modelValue }, this.items.map(item => h("option", { value: item.value }, item.label)))
  } })
  app.component("UButton", { props: { label: String, to: String }, render(this: { label: string, to?: string }) {
    return this.to ? h("a", { href: this.to }, this.label) : h("button", this.label)
  } })
}

const revision = {
  bytes: 24,
  createdAt: "2026-10-15T10:00:00.000Z",
  files: 2,
  id: "rev-2abcdef",
  message: "Update docs",
  metadata: { url: "https://github.com/org/repo/commit/rev-2abcdef" },
  parentId: "rev-1",
  ref: "main",
}

describe("Console Workspace history navigator", () => {
  it("renders refs, revision metadata, and pagination controls", async () => {
    const app = createSSRApp({
      render: () => h(History, {
        refs: [{ name: "main", head: revision }],
        revisions: [revision],
        selectedRef: "main",
        selectedRevision: revision.id,
        cursor: "main:2",
      }),
    })
    stubs(app)
    const html = await renderToString(app)
    expect(html).toContain("Workspace history ref")
    expect(html).toContain("rev-2ab · Update docs")
    expect(html).toContain("Update docs")
    expect(html).toContain("Open revision on GitHub")
    expect(html).toContain("Load older")
  })

  it("does not render unsafe revision URLs", async () => {
    const app = createSSRApp({
      render: () => h(History, {
        refs: [{ name: "main", head: revision }],
        revisions: [{ ...revision, metadata: { url: "javascript:alert(1)" } }],
        selectedRef: "main",
        selectedRevision: revision.id,
      }),
    })
    stubs(app)
    const html = await renderToString(app)
    expect(html).not.toContain("Open revision on GitHub")
    expect(html).not.toContain("javascript:")
  })
})
