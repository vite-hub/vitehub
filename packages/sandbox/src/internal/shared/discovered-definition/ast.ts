import { createRequire } from 'node:module'

import type { Import } from 'unimport'
import type ts from 'typescript'

const require = createRequire(import.meta.url)
const typescript: typeof import('typescript') = require('typescript')
const filesystemModuleSpecifiers = new Set([
  'child_process',
  'fs',
  'fs/promises',
  'node:child_process',
  'node:fs',
  'node:fs/promises',
  'node:sqlite',
])

export interface FilesystemPathReference {
  path: string
  relativeTo: 'module' | 'working-directory'
}

export function resolveImportLocalName(entry: Import) {
  return entry.as || entry.name
}

function getScriptKind(id: string) {
  // SAFETY: older supported TypeScript releases may omit the MTS and CTS enum members.
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

function readFilesystemPathReference(argument: ts.Expression | undefined): FilesystemPathReference | undefined {
  if (!argument)
    return undefined
  if (typescript.isStringLiteralLike(argument))
    return { path: argument.text, relativeTo: 'working-directory' }
  if (!typescript.isNewExpression(argument)
    || !typescript.isIdentifier(argument.expression)
    || argument.expression.text !== 'URL') {
    return undefined
  }
  const [path, base] = argument.arguments || []
  if (!path
    || !typescript.isStringLiteralLike(path)
    || !base
    || !typescript.isPropertyAccessExpression(base)
    || base.name.text !== 'url'
    || !typescript.isMetaProperty(base.expression)
    || base.expression.keywordToken !== typescript.SyntaxKind.ImportKeyword) {
    return undefined
  }
  return { path: path.text, relativeTo: 'module' }
}

export function findFilesystemPathReferences(source: string, id: string): FilesystemPathReference[] {
  const sourceFile = createSourceFile(id, source)
  const directBindings = new Set<string>()
  const namespaceBindings = new Set<string>()
  const references: FilesystemPathReference[] = []

  function filesystemRequireSpecifier(expression: ts.Expression | undefined): string | undefined {
    if (expression && (typescript.isPropertyAccessExpression(expression) || typescript.isElementAccessExpression(expression)))
      return filesystemRequireSpecifier(expression.expression)
    if (!expression
      || !typescript.isCallExpression(expression)
      || !typescript.isIdentifier(expression.expression)
      || expression.expression.text !== 'require') {
      return
    }
    const [specifier] = expression.arguments
    return specifier
      && typescript.isStringLiteralLike(specifier)
      && filesystemModuleSpecifiers.has(specifier.text)
      ? specifier.text
      : undefined
  }

  function addCommonJSBinding(name: ts.BindingName) {
    if (typescript.isIdentifier(name)) {
      directBindings.add(name.text)
      namespaceBindings.add(name.text)
      return
    }
    for (const element of name.elements) {
      if (!typescript.isOmittedExpression(element)) addCommonJSBinding(element.name)
    }
  }

  for (const statement of sourceFile.statements) {
    if (typescript.isImportEqualsDeclaration(statement)
      && !statement.isTypeOnly
      && typescript.isExternalModuleReference(statement.moduleReference)
      && statement.moduleReference.expression
      && typescript.isStringLiteralLike(statement.moduleReference.expression)
      && filesystemModuleSpecifiers.has(statement.moduleReference.expression.text)) {
      namespaceBindings.add(statement.name.text)
      continue
    }
    if (!typescript.isImportDeclaration(statement)
      || !typescript.isStringLiteralLike(statement.moduleSpecifier)
      || !filesystemModuleSpecifiers.has(statement.moduleSpecifier.text)
      || statement.importClause?.isTypeOnly) {
      continue
    }
    const clause = statement.importClause
    if (clause?.name)
      namespaceBindings.add(clause.name.text)
    const bindings = clause?.namedBindings
    if (bindings && typescript.isNamespaceImport(bindings))
      namespaceBindings.add(bindings.name.text)
    else if (bindings && typescript.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (!binding.isTypeOnly)
          directBindings.add(binding.name.text)
      }
    }
  }

  function collectCommonJSBindings(node: ts.Node) {
    if (typescript.isVariableDeclaration(node) && filesystemRequireSpecifier(node.initializer))
      addCommonJSBinding(node.name)
    typescript.forEachChild(node, collectCommonJSBindings)
  }

  collectCommonJSBindings(sourceFile)

  function visit(node: ts.Node) {
    if (typescript.isCallExpression(node) || typescript.isNewExpression(node)) {
      const direct = typescript.isIdentifier(node.expression) && directBindings.has(node.expression.text)
      const root = propertyAccessRoot(node.expression).current
      const namespaced = typescript.isIdentifier(root) && namespaceBindings.has(root.text)
      const inlineRequire = (typescript.isPropertyAccessExpression(node.expression)
        || typescript.isElementAccessExpression(node.expression))
        && Boolean(filesystemRequireSpecifier(node.expression))
      if (direct || namespaced || inlineRequire) {
        const reference = readFilesystemPathReference(node.arguments?.[0])
        if (reference)
          references.push(reference)
      }
    }
    typescript.forEachChild(node, visit)
  }

  visit(sourceFile)
  return references
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

type CommonJSModuleSpecifier = {
  path: string
  specifier?: string
  syntax:
    | 'exports-assignment'
    | 'exports-reference'
    | 'import-equals'
    | 'module-exports-assignment'
    | 'module-reference'
    | 'require'
    | 'require-property'
}

export function findCommonJSImportEqualsSpecifiers(source: string, id: string) {
  const sourceFile = createSourceFile(id, source)
  const specifiers: CommonJSModuleSpecifier[] = []

  function visit(node: ts.Node) {
    if (
      typescript.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      typescript.isExternalModuleReference(node.moduleReference)
    ) {
      const expression = node.moduleReference.expression
      specifiers.push({
        path: id,
        specifier:
          expression && typescript.isStringLiteralLike(expression) ? expression.text : undefined,
        syntax: 'import-equals',
      })
    }
    typescript.forEachChild(node, visit)
  }

  visit(sourceFile)
  return specifiers
}

function isExecutableIdentifierReference(node: ts.Identifier) {
  const parent = node.parent
  if (
    typescript.isImportClause(parent) ||
    typescript.isImportSpecifier(parent) ||
    typescript.isNamespaceImport(parent) ||
    typescript.isNamespaceExport(parent)
  )
    return false
  if (typescript.isExportSpecifier(parent)) {
    const declaration = parent.parent.parent
    if (declaration.moduleSpecifier) return false
    return parent.propertyName ? parent.propertyName === node : parent.name === node
  }
  if (
    typescript.isBindingElement(parent)
    && (parent.name === node || parent.propertyName === node)
  )
    return false
  if (typescript.isPropertyAccessExpression(parent) && parent.name === node) return false
  if (
    typescript.isLabeledStatement(parent) ||
    typescript.isBreakStatement(parent) ||
    typescript.isContinueStatement(parent)
  )
    return false
  if (!typescript.isShorthandPropertyAssignment(parent) && 'name' in parent && parent.name === node)
    return false
  return !('propertyName' in parent) || parent.propertyName !== node
}

export function findExecutableCommonJSModuleSpecifiers(sources: ReadonlyMap<string, string>) {
  const executableSources = new Map(
    [...sources].map(([path, source]) => [`/${path.replace(/^[/]+/, '')}`, source]),
  )
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    module: typescript.ModuleKind.ESNext,
    moduleDetection: typescript.ModuleDetectionKind.Force,
    noLib: true,
    noResolve: true,
    target: typescript.ScriptTarget.ES2022,
    types: [],
  }
  const sourceFiles = new Map<string, ts.SourceFile>()
  const host: ts.CompilerHost = {
    fileExists: (fileName) => executableSources.has(fileName),
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => '/',
    getDefaultLibFileName: () => '',
    getNewLine: () => '\n',
    getSourceFile(fileName, languageVersion) {
      const source = executableSources.get(fileName)
      if (source === undefined) return undefined
      let sourceFile = sourceFiles.get(fileName)
      if (!sourceFile) {
        sourceFile = typescript.createSourceFile(
          fileName,
          source,
          languageVersion,
          true,
          typescript.ScriptKind.JS,
        )
        sourceFiles.set(fileName, sourceFile)
      }
      return sourceFile
    },
    readFile: (fileName) => executableSources.get(fileName),
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
  }
  const program = typescript.createProgram({
    host,
    options,
    rootNames: [...executableSources.keys()],
  })
  const checker = program.getTypeChecker()
  const specifiers: CommonJSModuleSpecifier[] = []

  function isRuntimeBindingDeclaration(node: ts.Declaration) {
    return (
      typescript.isBindingElement(node) ||
      typescript.isClassDeclaration(node) ||
      typescript.isClassExpression(node) ||
      typescript.isFunctionDeclaration(node) ||
      typescript.isFunctionExpression(node) ||
      typescript.isImportClause(node) ||
      typescript.isImportSpecifier(node) ||
      typescript.isNamespaceImport(node) ||
      typescript.isParameter(node) ||
      typescript.isVariableDeclaration(node)
    )
  }

  function isBound(node: ts.Identifier) {
    const symbol = typescript.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node)
    return symbol?.declarations?.some(isRuntimeBindingDeclaration) ?? false
  }

  function visit(sourceFile: ts.SourceFile, node: ts.Node) {
    if (
      typescript.isCallExpression(node) &&
      typescript.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      !isBound(node.expression)
    ) {
      const argument = node.arguments[0]
      specifiers.push({
        path: sourceFile.fileName.slice(1),
        specifier: argument && typescript.isStringLiteralLike(argument) ? argument.text : undefined,
        syntax: 'require',
      })
    } else if (
      typescript.isPropertyAccessExpression(node) ||
      typescript.isElementAccessExpression(node)
    ) {
      const { current, properties } = propertyAccessRoot(node)
      if (typescript.isIdentifier(current) && current.text === 'require' && !isBound(current)) {
        specifiers.push({
          path: sourceFile.fileName.slice(1),
          specifier: properties.join('.'),
          syntax: 'require-property',
        })
      }
    } else if (
      typescript.isBinaryExpression(node) &&
      node.operatorToken.kind >= typescript.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= typescript.SyntaxKind.LastAssignment
    ) {
      const { current, properties } = propertyAccessRoot(node.left)
      if (
        typescript.isIdentifier(current) &&
        current.text === 'module' &&
        !isBound(current) &&
        properties[0] === 'exports'
      ) {
        specifiers.push({
          path: sourceFile.fileName.slice(1),
          syntax: 'module-exports-assignment',
        })
      } else if (
        typescript.isIdentifier(current) &&
        current.text === 'exports' &&
        !isBound(current) &&
        properties.length
      ) {
        specifiers.push({ path: sourceFile.fileName.slice(1), syntax: 'exports-assignment' })
      }
    } else if (
      typescript.isIdentifier(node) &&
      (node.text === 'module' || node.text === 'exports') &&
      isExecutableIdentifierReference(node) &&
      !isBound(node)
    ) {
      specifiers.push({
        path: sourceFile.fileName.slice(1),
        syntax: node.text === 'module' ? 'module-reference' : 'exports-reference',
      })
    }
    typescript.forEachChild(node, (child) => visit(sourceFile, child))
  }

  for (const sourceFile of program.getSourceFiles()) visit(sourceFile, sourceFile)
  return specifiers
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
