import { createSSRApp, h } from "vue"
import { renderToString } from "vue/server-renderer"
import { describe, expect, it } from "vitest"
import History from "../src/console/runtime/components/console-workspace-history.vue"

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
    app.component("UIcon", { props: { name: String }, template: "<span />" })
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
    app.component("UIcon", { props: { name: String }, template: "<span />" })
    const html = await renderToString(app)
    expect(html).not.toContain("Open revision on GitHub")
    expect(html).not.toContain("javascript:")
  })
})
