import { readFileSync } from "node:fs"

import { parse } from "vue/compiler-sfc"
import { expect, it } from "vitest"

const source = readFileSync(new URL("../src/console/runtime/components/console-database.vue", import.meta.url), "utf8")

type TemplateNode = NonNullable<NonNullable<ReturnType<typeof parse>["descriptor"]["template"]>["ast"]>["children"][number]
type ElementNode = Extract<TemplateNode, { tag: string }>

const elementType = 1
const attributeType = 6
const directiveType = 7

function staticClass(node: ElementNode): string {
  for (const prop of node.props) {
    if (prop.type === attributeType && prop.name === "class") return prop.value?.content ?? ""
  }
  return ""
}

function boundSource(node: ElementNode, name: string): string | undefined {
  for (const prop of node.props) {
    if (prop.type === directiveType && prop.rawName === `:${name}`) return prop.exp?.loc.source
  }
}

// The elements from the template root to the first element with this tag.
function pathTo(nodes: readonly TemplateNode[], tag: string): ElementNode[] | undefined {
  for (const node of nodes) {
    if (node.type !== elementType) continue
    if (node.tag === tag) return [node]
    const path = pathTo(node.children, tag)
    if (path) return [node, ...path]
  }
}

// UTable sticks its header inside its own root. A scrolling ancestor scrolls the header away with the rows.
it("lets the Database grid root scroll so its sticky header stays in view", () => {
  const path = pathTo(parse(source).descriptor.template?.ast?.children ?? [], "UTable")
  expect(path).toBeDefined()
  const ancestors = path!.slice(0, -1)
  expect(ancestors.filter(node => /\boverflow-(?:auto|scroll|[xy]-auto|[xy]-scroll)\b/.test(staticClass(node))).map(node => node.tag)).toEqual([])
  expect(boundSource(path!.at(-1)!, "ui")).toMatch(/root:\s*'[^']*\bflex-1\b/)
})
