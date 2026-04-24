import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import type ts from 'typescript'
import type { SandboxDefinitionOptions } from './module-types'

const require = createRequire(import.meta.url)

type TypeScript = typeof import('typescript')
type OptionsExpression = ts.Expression | null | undefined

const sandboxDefinitionSyntax = '`defineSandbox()`'

function getTypeScript(): TypeScript {
  return require('typescript') as TypeScript
}

function getSandboxDefinitionOptionsCall(expression: ts.Expression): OptionsExpression {
  const ts = getTypeScript()

  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'defineSandbox') {
    if (expression.arguments.length > 2)
      throw new Error(`[vitehub] ${sandboxDefinitionSyntax} accepts at most one handler and one options object.`)
    return expression.arguments[1] || null
  }

  return undefined
}

function readExportedOptionsExpression(sourceFile: ts.SourceFile): OptionsExpression {
  const ts = getTypeScript()
  const localDefinitions = new Map<string, OptionsExpression>()

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement))
      continue

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
        continue

      const options = getSandboxDefinitionOptionsCall(declaration.initializer)
      if (typeof options !== 'undefined')
        localDefinitions.set(declaration.name.text, options)
    }
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement))
      continue

    const options = getSandboxDefinitionOptionsCall(statement.expression)
    if (typeof options !== 'undefined')
      return options

    if (ts.isIdentifier(statement.expression) && localDefinitions.has(statement.expression.text))
      return localDefinitions.get(statement.expression.text)
  }

  return undefined
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
  if (ts.isIdentifier(node) && node.text === 'undefined')
    return undefined
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand))
    return -Number(node.operand.text)
  if (ts.isParenthesizedExpression(node))
    return readStaticValue(node.expression)
  if (ts.isBinaryExpression(node)) {
    const left = readStaticValue(node.left)
    const right = readStaticValue(node.right)

    if (typeof left === 'number' && typeof right === 'number') {
      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken:
          return left + right
        case ts.SyntaxKind.MinusToken:
          return left - right
        case ts.SyntaxKind.AsteriskToken:
          return left * right
        case ts.SyntaxKind.SlashToken:
          return left / right
        case ts.SyntaxKind.PercentToken:
          return left % right
        case ts.SyntaxKind.AsteriskAsteriskToken:
          return left ** right
      }
    }

    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken && typeof left === 'string' && typeof right === 'string')
      return left + right

    throw new Error(`[vitehub] ${sandboxDefinitionSyntax} options only support static arithmetic and string concatenation expressions.`)
  }
  if (ts.isArrayLiteralExpression(node))
    return node.elements.map((element) => {
      if (!ts.isExpression(element))
        throw new Error(`[vitehub] ${sandboxDefinitionSyntax} options arrays must use static values.`)
      return readStaticValue(element)
    })
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

export async function extractSandboxDefinitionOptions(file: string): Promise<SandboxDefinitionOptions | undefined> {
  const source = await readFile(file, 'utf8')
  const ts = getTypeScript()
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  const options = readExportedOptionsExpression(sourceFile)
  if (typeof options === 'undefined' || options === null)
    return undefined
  if (!ts.isObjectLiteralExpression(options))
    throw new Error(`[vitehub] ${sandboxDefinitionSyntax} options must be an object literal.`)

  return readStaticValue(options) as SandboxDefinitionOptions
}
