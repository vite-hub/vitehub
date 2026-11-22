import type { InjectionKey } from "vue"
import type { Node as ComarkNode } from "comark"

export interface DocsLearnActions {
  available: boolean
  running: boolean
  paths: readonly string[]
  show: (path: string) => void
  run: (command: string) => Promise<string>
}

export const docsLearnActionsKey: InjectionKey<DocsLearnActions> = Symbol("docs-learn-actions")

export function docsLearnGuideNodes(nodes: readonly ComarkNode[], paths: ReadonlySet<string>): ComarkNode[] {
  const link = (node: ComarkNode): ComarkNode => {
    if (typeof node === "string" || node[0] === null || node[0] === "pre") return node
    const [tag, attributes, ...children] = node
    if (tag === "code" && children.length === 1 && typeof children[0] === "string" && paths.has(children[0])) {
      return ["docs-learn-file", { path: children[0] }, node]
    }
    return [tag, attributes, ...children.map(link)]
  }
  return nodes.map(link)
}

export function docsLearnStepNodes(step: ComarkNode | undefined): ComarkNode[] {
  if (!step || typeof step === "string" || step[0] === null) return []
  const [, , ...children] = step
  const [first, ...rest] = children
  return first !== undefined && typeof first !== "string" && first[0] === "h2" ? rest : children
}
