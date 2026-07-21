import { createRequire } from 'node:module'

import type { Import } from 'unimport'
import type ts from 'typescript'

const require = createRequire(import.meta.url)
const typescript = require('typescript') as typeof import('typescript')

export function resolveImportLocalName(entry: Import) {
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

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return typescript.canHaveModifiers(node)
    && (typescript.getModifiers(node)?.some(modifier => modifier.kind === kind) ?? false)
}

export function hasExportedType(source: string, id: string, name: string) {
  const sourceFile = createSourceFile(id, source)
  return sourceFile.statements.some((statement) => {
    if (
      (typescript.isInterfaceDeclaration(statement) || typescript.isTypeAliasDeclaration(statement))
      && statement.name.text === name
    ) {
      return hasModifier(statement, typescript.SyntaxKind.ExportKeyword)
    }
    if (!typescript.isExportDeclaration(statement) || !statement.exportClause || !typescript.isNamedExports(statement.exportClause))
      return false
    return statement.exportClause.elements.some(element => element.name.text === name && (statement.isTypeOnly || element.isTypeOnly))
  })
}

function collectRuntimeModuleSpecifiers(source: string, id: string) {
  const sourceFile = createSourceFile(id, source)
  const specifiers: Array<{ node: ts.StringLiteralLike, specifier: string }> = []
  let hasNonLiteralDynamicImport = false

  function addSpecifier(node: ts.Expression | undefined) {
    if (node && typescript.isStringLiteralLike(node))
      specifiers.push({ node, specifier: node.text })
  }

  function visit(node: ts.Node) {
    if (typescript.isImportDeclaration(node)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings
      const hasRuntimeBinding = !clause
        || (!clause.isTypeOnly && (
          Boolean(clause.name)
          || !bindings
          || typescript.isNamespaceImport(bindings)
          || bindings.elements.length === 0
          || bindings.elements.some(element => !element.isTypeOnly)
        ))
      if (hasRuntimeBinding)
        addSpecifier(node.moduleSpecifier)
    }
    else if (typescript.isExportDeclaration(node)) {
      const clause = node.exportClause
      const hasRuntimeExport = !node.isTypeOnly && (
        !clause
        || typescript.isNamespaceExport(clause)
        || clause.elements.length === 0
        || clause.elements.some(element => !element.isTypeOnly)
      )
      if (hasRuntimeExport)
        addSpecifier(node.moduleSpecifier)
    }
    else if (typescript.isCallExpression(node)
      && node.expression.kind === typescript.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      if (argument && typescript.isStringLiteralLike(argument))
        addSpecifier(argument)
      else
        hasNonLiteralDynamicImport = true
    }
    typescript.forEachChild(node, visit)
  }

  visit(sourceFile)
  return { hasNonLiteralDynamicImport, sourceFile, specifiers }
}

export function findRuntimeModuleSpecifiers(source: string, id: string) {
  return collectRuntimeModuleSpecifiers(source, id).specifiers.map(entry => entry.specifier)
}

export function findRuntimeRelativeModuleSpecifiers(source: string, id: string) {
  return findRuntimeModuleSpecifiers(source, id).filter(specifier => /^\.\.?\//.test(specifier))
}

export function hasNonLiteralDynamicImport(source: string, id: string) {
  return collectRuntimeModuleSpecifiers(source, id).hasNonLiteralDynamicImport
}

function propertyAccessRoot(expression: ts.Expression) {
  const properties: string[] = []
  let current = expression
  while (typescript.isPropertyAccessExpression(current) || typescript.isElementAccessExpression(current)) {
    if (typescript.isPropertyAccessExpression(current)) {
      properties.unshift(current.name.text)
      current = current.expression
      continue
    }
    const argument = current.argumentExpression
    properties.unshift(argument && typescript.isStringLiteralLike(argument) ? argument.text : '*')
    current = current.expression
  }
  return { current, properties }
}

export function findCommonJSModuleSpecifiers(source: string, id: string) {
  const sourceFile = createSourceFile(id, source)
  const bindings = collectLexicalBindings(sourceFile)
  const specifiers: Array<{
    specifier?: string
    syntax: 'exports-assignment' | 'exports-reference' | 'import-equals' | 'module-exports-assignment' | 'module-reference' | 'require' | 'require-property'
  }> = []

  function isBound(node: ts.Identifier) {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (bindings.get(current)?.has(node.text))
        return true
    }
    return false
  }

  function visit(node: ts.Node) {
    if (typescript.isImportEqualsDeclaration(node)
      && !node.isTypeOnly
      && typescript.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression
      specifiers.push({
        specifier: expression && typescript.isStringLiteralLike(expression) ? expression.text : undefined,
        syntax: 'import-equals',
      })
    }
    else if (typescript.isCallExpression(node)
      && typescript.isIdentifier(node.expression)
      && node.expression.text === 'require'
      && !isBound(node.expression)) {
      const argument = node.arguments[0]
      specifiers.push({
        specifier: argument && typescript.isStringLiteralLike(argument) ? argument.text : undefined,
        syntax: 'require',
      })
    }
    else if (typescript.isPropertyAccessExpression(node) || typescript.isElementAccessExpression(node)) {
      const { current, properties } = propertyAccessRoot(node)
      if (typescript.isIdentifier(current) && current.text === 'require' && !isBound(current)) {
        specifiers.push({
          specifier: properties.join('.'),
          syntax: 'require-property',
        })
      }
    }
    else if (typescript.isBinaryExpression(node)
      && node.operatorToken.kind >= typescript.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= typescript.SyntaxKind.LastAssignment) {
      const { current, properties } = propertyAccessRoot(node.left)
      if (typescript.isIdentifier(current) && current.text === 'module' && !isBound(current) && properties[0] === 'exports')
        specifiers.push({ syntax: 'module-exports-assignment' })
      else if (typescript.isIdentifier(current) && current.text === 'exports' && !isBound(current) && properties.length)
        specifiers.push({ syntax: 'exports-assignment' })
    }
    else if (typescript.isIdentifier(node)
      && (node.text === 'module' || node.text === 'exports')
      && isRuntimeIdentifierReference(node)
      && !isBound(node)) {
      specifiers.push({ syntax: node.text === 'module' ? 'module-reference' : 'exports-reference' })
    }
    typescript.forEachChild(node, visit)
  }

  visit(sourceFile)
  return specifiers
}

function collectLexicalBindings(sourceFile: ts.SourceFile) {
  const bindings = new Map<ts.Node, Set<string>>()

  function add(scope: ts.Node | undefined, name: ts.BindingName | ts.Identifier | undefined) {
    if (!scope || !name)
      return
    if (typescript.isIdentifier(name)) {
      const names = bindings.get(scope) || new Set<string>()
      names.add(name.text)
      bindings.set(scope, names)
      return
    }
    for (const element of name.elements) {
      if (!typescript.isOmittedExpression(element))
        add(scope, element.name)
    }
  }

  function lexicalScope(node: ts.Node | undefined) {
    for (let current = node; current; current = current.parent) {
      if (typescript.isSourceFile(current)
        || typescript.isBlock(current)
        || typescript.isFunctionLike(current)
        || typescript.isCatchClause(current))
        return current
    }
  }

  function functionScope(node: ts.Node | undefined) {
    for (let current = node; current; current = current.parent) {
      if (typescript.isSourceFile(current) || typescript.isFunctionLike(current))
        return current
    }
  }

  function visit(node: ts.Node) {
    if (typescript.isImportClause(node) && !node.isTypeOnly) {
      add(sourceFile, node.name)
    }
    else if (typescript.isImportSpecifier(node)
      && !node.isTypeOnly
      && !node.parent.parent.isTypeOnly) {
      add(sourceFile, node.name)
    }
    else if (typescript.isNamespaceImport(node) && !node.parent.isTypeOnly) {
      add(sourceFile, node.name)
    }
    else if (typescript.isVariableDeclaration(node)) {
      const declarationList = node.parent
      if (isAmbientDeclaration(node)) {
        typescript.forEachChild(node, visit)
        return
      }
      const scope = typescript.isVariableDeclarationList(declarationList)
        && !(declarationList.flags & typescript.NodeFlags.BlockScoped)
        ? functionScope(declarationList.parent)
        : lexicalScope(declarationList.parent)
      add(scope, node.name)
    }
    else if (typescript.isParameter(node)) {
      add(functionScope(node.parent), node.name)
    }
    else if ((typescript.isFunctionDeclaration(node) || typescript.isClassDeclaration(node))
      && !isAmbientDeclaration(node)) {
      add(lexicalScope(node.parent), node.name)
    }
    else if (typescript.isFunctionExpression(node)) {
      add(node, node.name)
    }
    else if (typescript.isCatchClause(node)) {
      add(node, node.variableDeclaration?.name)
    }
    typescript.forEachChild(node, visit)
  }

  visit(sourceFile)
  return bindings
}

function isAmbientDeclaration(node: ts.Node) {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (typescript.isSourceFile(current))
      return current.isDeclarationFile
    if (hasModifier(current, typescript.SyntaxKind.DeclareKeyword))
      return true
  }
  return false
}

function isRuntimeIdentifierReference(node: ts.Identifier) {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (typescript.isTypeNode(current))
      return false
    if (typescript.isExpression(current) || typescript.isStatement(current))
      break
  }
  const parent = node.parent
  if (typescript.isPropertyAccessExpression(parent) && parent.name === node)
    return false
  const namedParent = parent as ts.Node & { name?: ts.Node }
  if (!typescript.isShorthandPropertyAssignment(parent) && namedParent.name === node)
    return false
  const propertyParent = parent as ts.Node & { propertyName?: ts.Node }
  if (propertyParent.propertyName === node)
    return false
  const labeledParent = parent as ts.Node & { label?: ts.Node }
  if (labeledParent.label === node)
    return false
  return true
}

export function rewriteRuntimeRelativeModuleSpecifiers(
  source: string,
  id: string,
  rewrite: (specifier: string) => string,
) {
  const { sourceFile, specifiers } = collectRuntimeModuleSpecifiers(source, id)
  const edits: Array<{ end: number, replacement: string, start: number }> = []

  for (const { node, specifier } of specifiers) {
    if (!/^\.\.?\//.test(specifier))
      continue
    const replacement = rewrite(specifier)
    if (replacement !== specifier) {
      edits.push({
        start: node.getStart(sourceFile),
        end: node.getEnd(),
        replacement: JSON.stringify(replacement),
      })
    }
  }

  return edits
    .sort((left, right) => right.start - left.start)
    .reduce(
      (contents, edit) => `${contents.slice(0, edit.start)}${edit.replacement}${contents.slice(edit.end)}`,
      source,
    )
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

export function injectTypeImports(source: string, imports: Import[], id: string) {
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

export async function injectTypeImportsFromUnimport(
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
