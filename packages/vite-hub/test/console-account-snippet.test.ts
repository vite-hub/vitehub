import { createSSRApp, defineComponent } from "vue"
import { renderToString } from "vue/server-renderer"
import { describe, expect, it, vi } from "vitest"

vi.mock("@vite-hub/ui", async () => {
  const { defineComponent, h } = await import("vue")
  const passThrough = defineComponent({ setup: (_, { slots }) => () => h("div", slots.default?.()) })
  return {
    CodeBlock: passThrough,
    CodeBlockActions: passThrough,
    CodeBlockContent: passThrough,
    CodeBlockCopyButton: defineComponent({ props: { value: String }, setup: () => () => null }),
    CodeBlockHeader: passThrough,
  }
})
vi.mock("../src/console/runtime/client/toast", () => ({ useConsoleToast: () => ({ show: vi.fn() }) }))
import AccountSnippet from "../src/console/runtime/components/console-account-snippet.vue"

async function renderSnippet(): Promise<{ html: string, tabs: string[] }> {
  const tabs: string[] = []
  const app = createSSRApp(AccountSnippet)
  app.component("UTabs", defineComponent({
    props: { items: { type: Array, default: () => [] } },
    setup(props) {
      for (const item of props.items) tabs.push(String(Reflect.get(Object(item), "label")))
      return () => null
    },
  }))
  return { html: await renderToString(app), tabs }
}

describe("Link app snippet", () => {
  it("shows the config for Nuxt, Vite and Nitro", async () => {
    const { html, tabs } = await renderSnippet()
    expect(tabs).toEqual(["Nuxt", "Vite", "Nitro"])
    expect(html).toContain("import { nitro } from &#39;nitro/vite&#39;")
    expect(html).toContain("}), nitro()],")
  })

  it("tells a Node.js app to set publicUrl and build again", async () => {
    const { html } = await renderSnippet()
    expect(html).toMatch(/On the Node\.js host, also set <code[^>]*>publicUrl<\/code> to the URL that you link, and build again\./)
  })
})
