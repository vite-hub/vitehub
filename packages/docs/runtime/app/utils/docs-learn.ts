import type { InjectionKey } from "vue"
import type { Node as ComarkNode } from "comark"

/** What a code block of a `learn` page can ask of the workspace beside it. */
export interface DocsLearnActions {
  /** Whether the workspace runs on this device and browser. */
  available: boolean
  /** Whether a request can run now: after the install, while the dev server runs. */
  running: boolean
  /** Paths of the app, for "Show in editor". */
  paths: readonly string[]
  show: (path: string) => void
  /** Runs a lesson command in the workspace and returns its output. */
  run: (command: string) => Promise<string>
}

export const docsLearnActionsKey: InjectionKey<DocsLearnActions> = Symbol("docs-learn-actions")

/**
 * The nodes of a step without its leading `## Title`, which the workspace guide shows over the text. Inline code that
 * names a file of the lesson, such as `server/api/kv.ts`, becomes a `docs-learn-file` node, a link that opens the file.
 * Code blocks stay as they are.
 */
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

/** The children of a `::tutorial-step` node, without the `## Title` that starts it. */
export function docsLearnStepNodes(step: ComarkNode | undefined): ComarkNode[] {
  if (!step || typeof step === "string" || step[0] === null) return []
  const [, , ...children] = step
  const [first, ...rest] = children
  return first !== undefined && typeof first !== "string" && first[0] === "h2" ? rest : children
}
