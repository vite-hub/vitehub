import { line, parseProgram, walk } from "@vite-hub/internal/ast"

import { codemodError } from "../error-diagnostics.ts"

export function assertModuleRemoved(file: string, code: string, ...packages: string[]): void {
  walk(parseProgram(code, { typescript: !/\.m?js$/.test(file) }), (node) => {
    const text = node.type === "StringLiteral" ? node.value : node.type === "TemplateElement" ? node.value.cooked : undefined
    if (text && packages.some(name => text === name || text.startsWith(`${name}/`))) {
      throw codemodError(`${file}:${line(node)}: Remove the remaining ${text} reference before migrating.`)
    }
  })
}
