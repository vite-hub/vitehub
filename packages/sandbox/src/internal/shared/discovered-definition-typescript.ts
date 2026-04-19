import { createRequire } from 'node:module'
import type { Import } from 'unimport'
import type ts from 'typescript'

const require = createRequire(import.meta.url)
const typescript = require('typescript') as typeof import('typescript')

function resolveImportLocalName(entry: Import) {
  return entry.as || entry.name
}

function getScriptKind(id: string) {
  const scriptKind = typescript.ScriptKind as typeof typescript.ScriptKind & {
    MTS?: typeof typescript.ScriptKind.TS
    CTS?: typeof typescript.ScriptKind.TS
  }
  if (id.endsWith('.tsx'))
    return typescript.ScriptKind.TSX
  if (id.endsWith('.jsx'))
    return typescript.ScriptKind.JSX
  if (id.endsWith('.mts'))
    return scriptKind.MTS ?? typescript.ScriptKind.TS
  if (id.endsWith('.cts'))
    return scriptKind.CTS ?? typescript.ScriptKind.TS
  if (id.endsWith('.mjs'))
    return typescript.ScriptKind.JS
  if (id.endsWith('.cjs'))
    return typescript.ScriptKind.JS
  if (id.endsWith('.js'))
    return typescript.ScriptKind.JS
  return typescript.ScriptKind.TS
}

function createSourceFile(id: string, source: string) {
  return typescript.createSourceFile(id, source, typescript.ScriptTarget.Latest, true, getScriptKind(id))
}

function collectExplicitImportNames(sourceFile: ts.SourceFile) {
  const names = new Set<string>()

  for (const statement of sourceFile.statements) {
    if (!typescript.isImportDeclaration(statement))
      continue

    const clause = statement.importClause
    if (!clause)
      continue

    if (clause.name)
      names.add(clause.name.text)

    const bindings = clause.namedBindings
    if (!bindings)
      continue

    if (typescript.isNamespaceImport(bindings)) {
      names.add(bindings.name.text)
      continue
    }

    for (const element of bindings.elements)
      names.add(element.name.text)
  }

  return names
}

function collectDeclaredTypeNames(sourceFile: ts.SourceFile) {
  const names = new Set<string>()

  function visit(node: ts.Node) {
    if (
      (typescript.isInterfaceDeclaration(node)
        || typescript.isTypeAliasDeclaration(node)
        || typescript.isClassDeclaration(node)
        || typescript.isEnumDeclaration(node))
      && node.name
    ) {
      names.add(node.name.text)
    }

    if (
      (typescript.isFunctionDeclaration(node)
        || typescript.isClassDeclaration(node)
        || typescript.isInterfaceDeclaration(node)
        || typescript.isMethodDeclaration(node)
        || typescript.isArrowFunction(node)
        || typescript.isFunctionExpression(node)
        || typescript.isTypeAliasDeclaration(node))
      && node.typeParameters
    ) {
      for (const parameter of node.typeParameters)
        names.add(parameter.name.text)
    }

    typescript.forEachChild(node, visit)
  }

  visit(sourceFile)
  return names
}

function collectTypeReferenceNames(sourceFile: ts.SourceFile) {
  const names = new Set<string>()

  function addEntityName(name: ts.EntityName) {
    if (typescript.isIdentifier(name))
      names.add(name.text)
  }

  function visit(node: ts.Node) {
    if (typescript.isImportTypeNode(node) || typescript.isTypeQueryNode(node))
      return

    if (typescript.isTypeReferenceNode(node)) {
      addEntityName(node.typeName)
      node.typeArguments?.forEach(argument => visit(argument))
      return
    }

    if (typescript.isExpressionWithTypeArguments(node)) {
      if (typescript.isIdentifier(node.expression))
        names.add(node.expression.text)
      node.typeArguments?.forEach(argument => visit(argument))
      return
    }

    typescript.forEachChild(node, visit)
  }

  visit(sourceFile)
  return names
}

function groupTypeImports(imports: Import[]) {
  const grouped = new Map<string, Import[]>()

  for (const entry of imports) {
    const from = entry.typeFrom || entry.from
    const entries = grouped.get(from)
    if (entries) {
      entries.push(entry)
      continue
    }
    grouped.set(from, [entry])
  }

  return grouped
}

function stringifyTypeImport(entry: Import) {
  const localName = resolveImportLocalName(entry)
  if (localName === entry.name)
    return entry.name
  return `${entry.name} as ${localName}`
}

function injectTypeImports(source: string, imports: Import[], id: string) {
  if (!imports.length)
    return source

  const sourceFile = createSourceFile(id, source)
  const importStatements = sourceFile.statements.filter(typescript.isImportDeclaration)
  const groupedImports = groupTypeImports(imports)
  const block = Array.from(groupedImports.entries()).map(([from, entries]) =>
    `import type { ${entries.map(stringifyTypeImport).join(', ')} } from ${JSON.stringify(from)}`
  ).join('\n')

  if (!block)
    return source

  const insertAt = importStatements.at(-1)?.end ?? (source.startsWith('#!')
    ? (source.indexOf('\n') + 1)
    : 0)
  const prefix = source.slice(0, insertAt)
  const suffix = source.slice(insertAt)
  const needsLeadingNewline = insertAt > 0 && !prefix.endsWith('\n')
  const needsTrailingNewline = suffix.length > 0 && !suffix.startsWith('\n')

  return `${prefix}${needsLeadingNewline ? '\n' : ''}${block}${needsTrailingNewline ? '\n' : ''}${suffix}`
}

export async function injectTypeImportsFromImports(
  source: string,
  id: string,
  imports: Import[],
) {
  const sourceFile = createSourceFile(id, source)
  const explicitImports = collectExplicitImportNames(sourceFile)
  const declaredTypes = collectDeclaredTypeNames(sourceFile)
  const usedTypes = collectTypeReferenceNames(sourceFile)
  const pendingImports: Import[] = []

  for (const entry of imports) {
    if (!entry.type || entry.disabled)
      continue

    const localName = resolveImportLocalName(entry)
    if (!usedTypes.has(localName))
      continue
    if (explicitImports.has(localName) || declaredTypes.has(localName))
      continue

    pendingImports.push(entry)
    explicitImports.add(localName)
  }

  return injectTypeImports(source, pendingImports, id)
}
