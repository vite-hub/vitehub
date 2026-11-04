import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parse } from "vue/compiler-sfc"

interface TemplateNode {
  children?: TemplateNode[]
  props?: Array<{ name: string; arg?: { content?: string } }>
  tag?: string
}

const isLive = (node: TemplateNode) => node.props?.some(prop => prop.name === "aria-live" || prop.arg?.content === "aria-live") ?? false

function* nodes(node: TemplateNode): Generator<TemplateNode> {
  yield node
  for (const child of node.children ?? []) yield* nodes(child)
}

// A live region reads every change inside it. Around a list, a thread, or a page body, a screen reader reads it all again.
const pageContent = new Set(["AgentInvocation", "ConsoleConnectionState", "header", "main", "table", "textarea", "ul", "ol"])

describe("Console live regions", () => {
  it.each(["console-app.vue", "console-channels.vue", "console-definitions.vue", "console-kv.vue"])("%s announces state, not page content", (file) => {
    const source = readFileSync(new URL(`../src/console/runtime/components/${file}`, import.meta.url), "utf8")
    const template = parse(source).descriptor.template?.ast as TemplateNode | undefined
    expect(template).toBeDefined()
    const wrapped = [...nodes(template!)]
      .filter(isLive)
      .flatMap(region => [...nodes(region)].slice(1).filter(node => node.tag && pageContent.has(node.tag)).map(node => node.tag))
    expect(wrapped).toEqual([])
  })
})
