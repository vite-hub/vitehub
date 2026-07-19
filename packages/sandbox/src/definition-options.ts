import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import type ts from 'typescript'
import type { SandboxDefinitionOptions } from './module-types'

const require = createRequire(import.meta.url)

type TypeScript = typeof import('typescript')
type OptionsExpression = ts.Expression | null | undefined

const sandboxDefinitionSyntax = '`defineSandbox()`'
const cloudflareDockerfileFragmentHelper = 'defineDockerfileFragment'
const cloudflareDockerfileFragmentImports = new Set([
  '@vite-hub/sandbox/cloudflare',
  'vite-hub/sandbox/cloudflare',
])
type CloudflareDockerfileFragmentMatch = {
  fragment: string
  importDeclaration: ts.ImportDeclaration
  expressionStatement: ts.ExpressionStatement
}

type CloudflareDockerfileFragmentImport = {
  declaration: ts.ImportDeclaration
  localName: string
}

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

  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement))
      continue

    const options = getSandboxDefinitionOptionsCall(statement.expression)
    if (typeof options !== 'undefined')
      return options
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
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand))
    return -Number(node.operand.text)
  if (ts.isParenthesizedExpression(node))
    return readStaticValue(node.expression)
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

function findCloudflareDockerfileFragmentImport(sourceFile: ts.SourceFile): CloudflareDockerfileFragmentImport | undefined {
  const ts = getTypeScript()
  let match: CloudflareDockerfileFragmentImport | undefined

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !cloudflareDockerfileFragmentImports.has(statement.moduleSpecifier.text)) {
      continue
    }

    const importClause = statement.importClause
    const bindings = importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) {
      throw new Error('[vitehub] `defineDockerfileFragment` must be imported as a named import from `vite-hub/sandbox/cloudflare`.')
    }

    const specifier = bindings.elements.find((specifier) => {
      return (specifier.propertyName?.text || specifier.name.text) === cloudflareDockerfileFragmentHelper
    })
    if (!specifier)
      continue
    if (importClause?.name || bindings.elements.length !== 1)
      throw new Error('[vitehub] `defineDockerfileFragment` must be imported by itself from `vite-hub/sandbox/cloudflare`.')
    if (match)
      throw new Error('[vitehub] `defineDockerfileFragment` may be imported only once per Sandbox Definition.')

    match = { declaration: statement, localName: specifier.name.text }
  }

  return match
}

function readCloudflareDockerfileFragment(sourceFile: ts.SourceFile): CloudflareDockerfileFragmentMatch | undefined {
  const ts = getTypeScript()
  const helperImport = findCloudflareDockerfileFragmentImport(sourceFile)
  if (!helperImport)
    return
  const { declaration: importDeclaration, localName } = helperImport

  let match: CloudflareDockerfileFragmentMatch | undefined

  function visit(node: ts.Node) {
    if (!ts.isTaggedTemplateExpression(node)
      || !ts.isIdentifier(node.tag)
      || node.tag.text !== localName) {
      ts.forEachChild(node, visit)
      return
    }
    const statement = node.parent
    if (!ts.isExpressionStatement(statement) || statement.parent !== sourceFile)
      throw new Error('[vitehub] `defineDockerfileFragment` must appear once as a top-level tagged-template statement.')
    if (match)
      throw new Error('[vitehub] `defineDockerfileFragment` may appear only once per Sandbox Definition.')
    if (!ts.isNoSubstitutionTemplateLiteral(node.template)) {
      throw new Error('[vitehub] `defineDockerfileFragment` requires one static template without interpolations.')
    }

    const fragment = node.template.getText(sourceFile).slice(1, -1)
    if (/^[ \t]*FROM(?:[ \t]|$)/im.test(fragment)) {
      throw new Error('[vitehub] `defineDockerfileFragment` extends ViteHub\'s version-matched Cloudflare Sandbox base and cannot contain FROM. Configure an application-owned Dockerfile for a custom base image.')
    }

    match = { fragment, importDeclaration, expressionStatement: statement }
  }

  ts.forEachChild(sourceFile, visit)
  if (!match)
    throw new Error('[vitehub] `defineDockerfileFragment` must appear once as a top-level tagged-template statement.')

  return match
}

export async function extractCloudflareDockerfileFragment(file: string): Promise<string | undefined> {
  const source = await readFile(file, 'utf8')
  const ts = getTypeScript()
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  return readCloudflareDockerfileFragment(sourceFile)?.fragment
}

export function stripCloudflareDockerfileFragment(source: string, file: string): string {
  const ts = getTypeScript()
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const match = readCloudflareDockerfileFragment(sourceFile)
  if (!match)
    return source

  const ranges = [match.importDeclaration, match.expressionStatement]
    .map(node => ({ start: node.getStart(sourceFile), end: node.getEnd() }))
    .sort((left, right) => right.start - left.start)

  return ranges.reduce(
    (result, range) => `${result.slice(0, range.start)}${result.slice(range.end)}`,
    source,
  )
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
