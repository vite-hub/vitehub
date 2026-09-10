import { parseMarkdown } from "comark"
import type { Node } from "comark"
import { markdownTemplateErrorDiagnostics as diagnostics } from "./error-diagnostics.ts"

// Comark's block components run before multiline code spans. Protect component
// lines that its own code parser identifies as literal, then restore after rendering.
export async function prepareTemplate(source: string) {
  const prefix = `VITEHUBCODE${crypto.randomUUID().replaceAll("-", "")}`
  const lines: string[] = []
  const masked = source.replace(/^([\t ]*)(:[^\r\n]*)$/gm, (_match, indent: string, line: string) =>
    `${indent}${prefix}${lines.push(line) - 1}END`)
  const pattern = new RegExp(`${prefix}(\\d+)END`, "g")
  const inCode = new Set<number>()
  const visit = (nodes: Node[], literal = false) => {
    for (const node of nodes) {
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Comark represents text nodes as strings and element nodes as tuples.
      if (typeof node === "string") {
        if (literal) for (const match of node.matchAll(pattern)) inCode.add(Number(match[1]))
      }
      // SAFETY: Comark element tuple entries after the tag and attributes are child nodes.
      else if (node[0] !== null) visit(node.slice(2) as Node[], literal || node[0] === "code")
    }
  }
  if (lines.length) visit((await parseMarkdown(masked, { autoClose: false, autoUnwrap: false, linkify: false })).nodes)
  const template = masked.replace(pattern, (token, index: string) => inCode.has(Number(index)) ? token : lines[Number(index)]!)
  validateBranches(template)
  return { template, restore: (rendered: string) => rendered.replace(pattern, (_token, index: string) => lines[Number(index)]!) }
}

function validateBranches(template: string): void {
  const stack: Array<{ tag: string, sawElse: boolean }> = []
  for (const line of template.split(/\r?\n/)) {
    if (/^\s*::\s*$/.test(line)) { stack.pop(); continue }
    const match = line.match(/^\s*::([\w-]+)(?:\{(.*)\})?\s*$/)
    if (!match) continue
    const tag = match[1]!
    if (tag !== "else" && tag !== "else-if") { stack.push({ tag, sawElse: false }); continue }
    const current = stack.at(-1)
    if (current?.tag === "else") {
      throw diagnostics.MARKDOWN_TEMPLATE_R0026({ message: `[vitehub] Markdown template ${tag} block cannot follow else.` })
    }
    if (current?.tag !== "if" && current?.tag !== "else-if") {
      throw diagnostics.MARKDOWN_TEMPLATE_R0025({ message: `[vitehub] Markdown template ${tag} block must follow an if block.` })
    }
    if (current.sawElse) {
      throw diagnostics.MARKDOWN_TEMPLATE_R0026({ message: `[vitehub] Markdown template ${tag} block cannot follow else.` })
    }
    if (tag === "else") {
      if (match[2]?.trim()) throw diagnostics.MARKDOWN_TEMPLATE_R0027({ message: "[vitehub] Markdown template else block does not accept a condition." })
      current.sawElse = true
    }
    stack.push({ tag, sawElse: false })
  }
  if (stack.some(entry => entry.tag === "if" || entry.tag === "else-if" || entry.tag === "else")) {
    throw diagnostics.MARKDOWN_TEMPLATE_R0029({ message: "[vitehub] Markdown template if block is missing a closing :: line." })
  }
}
