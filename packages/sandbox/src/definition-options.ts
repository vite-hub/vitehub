import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import type ts from 'typescript'
import type { SandboxDefinitionOptions } from './module-types'

const require = createRequire(import.meta.url)
const sandboxDefinitionSyntax = '`defineSandbox({ run, ...options })`'

type TypeScript = typeof import('typescript')

function getTypeScript(): TypeScript {
  return require('typescript') as TypeScript
}

function readStaticValue(node: ts.Expression): unknown {
  const ts = getTypeScript()
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text
  if (ts.isNumericLiteral(node))
    return Number(node.text)
  if (node.kind === ts.SyntaxKind.TrueKeyword)
    return true
  if (node.kind === ts.SyntaxKind.FalseKeyword)
    return false
  if (node.kind === ts.SyntaxKind.NullKeyword)
    return null
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand))
    return -Number(node.operand.text)
  if (ts.isParenthesizedExpression(node))
    return readStaticValue(node.expression)
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element) => {
      if (!ts.isExpression(element))
        throw new Error(`[vitehub] ${sandboxDefinitionSyntax} options arrays must use static values.`)
      return readStaticValue(element)
    })
  }
  if (ts.isObjectLiteralExpression(node)) {
    const value: Record<string, unknown> = {}
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property))
        throw new Error(`[vitehub] ${sandboxDefinitionSyntax} options must use plain object literals.`)
      const key = ts.isIdentifier(property.name)
        ? property.name.text
        : ts.isStringLiteral(property.name)
          ? property.name.text
          : undefined
      if (!key)
        throw new Error(`[vitehub] ${sandboxDefinitionSyntax} options only support identifier or string-literal keys.`)
      value[key] = readStaticValue(property.initializer)
    }
    return value
  }
  throw new Error(`[vitehub] ${sandboxDefinitionSyntax} options must use static JSON-serializable values.`)
}

function readDefinitionObject(sourceFile: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  const ts = getTypeScript()
  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement))
      continue
    const expression = statement.expression
    if (!ts.isCallExpression(expression)
      || !ts.isIdentifier(expression.expression)
      || expression.expression.text !== 'defineSandbox') {
      continue
    }
    if (expression.arguments.length !== 1 || !ts.isObjectLiteralExpression(expression.arguments[0])) {
      throw new Error(`[vitehub] ${sandboxDefinitionSyntax} requires one direct object literal.`)
    }
    return expression.arguments[0]
  }
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  const ts = getTypeScript()
  if (!('name' in property) || !property.name)
    return undefined
  return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
    ? property.name.text
    : undefined
}

export async function extractSandboxDefinitionOptions(file: string): Promise<SandboxDefinitionOptions | undefined> {
  const source = await readFile(file, 'utf8')
  const ts = getTypeScript()
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const input = readDefinitionObject(sourceFile)
  if (!input)
    return undefined

  const options: Record<string, unknown> = {}
  let hasRun = false
  for (const property of input.properties) {
    const key = propertyName(property)
    if (key === 'run' && ts.isShorthandPropertyAssignment(property)) {
      hasRun = true
      continue
    }
    if (!key || (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)))
      throw new Error(`[vitehub] ${sandboxDefinitionSyntax} requires explicit object properties.`)
    if (key === 'run') {
      hasRun = true
      continue
    }
    if (!ts.isPropertyAssignment(property))
      throw new Error(`[vitehub] ${sandboxDefinitionSyntax} options must use static values.`)
    options[key] = readStaticValue(property.initializer)
  }
  if (!hasRun)
    throw new Error(`[vitehub] ${sandboxDefinitionSyntax} requires a \`run\` handler.`)
  return Object.keys(options).length ? options as SandboxDefinitionOptions : undefined
}
