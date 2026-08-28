import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import type ts from 'typescript'
import type { SandboxDefinitionOptions } from './module-types'

const require = createRequire(import.meta.url)
const sandboxDefinitionSyntax = '`defineSandbox({ run, ...options })`'

type TypeScript = typeof import('typescript')

export interface ExtractedSandboxDefinitionMetadata {
  options?: SandboxDefinitionOptions
  project?: boolean
}

function getTypeScript(): TypeScript {
  // SAFETY: this loads the TypeScript package paired with the compiler node types used below.
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

function readSandboxDefinitionFactories(sourceFile: ts.SourceFile) {
  const ts = getTypeScript()
  const names = new Set(['defineSandbox'])
  const namespaces = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== '@vite-hub/sandbox'
      || !statement.importClause?.namedBindings) {
      continue
    }
    const bindings = statement.importClause.namedBindings
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text)
      continue
    }
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === 'defineSandbox')
        names.add(element.name.text)
    }
  }
  return { names, namespaces }
}

function readDefinitionObject(sourceFile: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  const ts = getTypeScript()
  const factories = readSandboxDefinitionFactories(sourceFile)
  const immutableBindings = new Map<string, ts.Expression>()
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)
      || !(statement.declarationList.flags & ts.NodeFlags.Const)) {
      continue
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer)
        immutableBindings.set(declaration.name.text, declaration.initializer)
    }
  }
  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement))
      continue
    let expression: ts.Expression | undefined = statement.expression
    const seen = new Set<string>()
    while (expression) {
      if (ts.isParenthesizedExpression(expression)) {
        expression = expression.expression
        continue
      }
      if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
        seen.add(expression.text)
        expression = immutableBindings.get(expression.text)
        continue
      }
      break
    }
    if (!expression)
      continue
    if (!ts.isCallExpression(expression)) {
      continue
    }
    const factory = expression.expression
    const isFactory = ts.isIdentifier(factory)
      ? factories.names.has(factory.text)
      : ts.isPropertyAccessExpression(factory)
        && ts.isIdentifier(factory.expression)
        && factories.namespaces.has(factory.expression.text)
        && factory.name.text === 'defineSandbox'
    if (!isFactory) {
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

export async function extractSandboxDefinitionMetadata(file: string): Promise<ExtractedSandboxDefinitionMetadata | undefined> {
  const source = await readFile(file, 'utf8')
  const ts = getTypeScript()
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const input = readDefinitionObject(sourceFile)
  if (!input)
    return undefined

  const options: Record<string, unknown> = {}
  let project: boolean | undefined
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
    const value = readStaticValue(property.initializer)
    if (key === 'project') {
      if (value !== true && value !== false)
        throw new Error(`[vitehub] ${sandboxDefinitionSyntax} project must be a boolean.`)
      project = value
    }
    else {
      options[key] = value
    }
  }
  if (!hasRun)
    throw new Error(`[vitehub] ${sandboxDefinitionSyntax} requires a \`run\` handler.`)
  // SAFETY: readStaticValue parsed every option into the JSON-compatible Definition option contract.
  const runtimeOptions = Object.keys(options).length ? options as SandboxDefinitionOptions : undefined
  return runtimeOptions || project !== undefined
    ? {
        ...(runtimeOptions ? { options: runtimeOptions } : {}),
        ...(project !== undefined ? { project } : {}),
      }
    : undefined
}
