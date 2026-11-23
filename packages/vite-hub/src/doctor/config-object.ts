import { parseProgram } from "@vite-hub/internal/ast"

export function configObject(text: string | undefined) {
  if (text === undefined) return
  try {
    const program = parseProgram(text).program
    const exported = program.body.find(node => node.type === "ExportDefaultDeclaration")?.declaration
    const value = exported?.type === "Identifier"
      ? program.body.flatMap(node => node.type === "VariableDeclaration" && node.kind === "const" ? node.declarations : [])
        .find(node => node.id.type === "Identifier" && node.id.name === exported.name)?.init
      : exported
    const object = value?.type === "CallExpression" ? value.arguments[0] : value
    if (object?.type === "ObjectExpression") return object
  }
  catch {
    return undefined
  }
}
