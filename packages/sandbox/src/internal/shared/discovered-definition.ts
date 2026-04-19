import { readFile } from 'node:fs/promises'
import { builtinModules, createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'pathe'
import { build, type Loader, type Plugin } from 'esbuild'
import { createUnimport, type Import, type ScanDir } from 'unimport'
import type { NitroImportsOptions } from './server-imports'
import { isNitroAutoImportEnabled } from './server-imports'
import type { ServerImport } from './runtime-artifacts'
import type ts from 'typescript'

export interface DiscoveredDefinitionCompilerOptions {
  rootDir: string
  scanRoots: string[]
  nitroImports?: NitroImportsOptions
  featureImports?: ServerImport[]
}

export interface DiscoveredDefinitionBundleOptions {
  filename: string
  source: string
  external?: string[]
  loader?: Loader
  packages?: 'bundle' | 'external'
  plugins?: Plugin[]
}

export interface DiscoveredDefinitionModuleGraph {
  entry: string
  modules: Record<string, string>
}

export interface DiscoveredDefinitionCompiler {
  enabled: boolean
  injectSource: (source: string, id: string) => Promise<string>
  readSource: (id: string) => Promise<string>
  bundleModule: (options: DiscoveredDefinitionBundleOptions) => Promise<string>
}

const builtinModuleSet = new Set([
  ...builtinModules,
  ...builtinModules.map(name => `node:${name}`),
])
const require = createRequire(import.meta.url)
const typescript = require('typescript') as typeof import('typescript')

function normalizeDir(rootDir: string, dir: string | ScanDir): string | ScanDir {
  if (typeof dir === 'string')
    return isAbsolute(dir) ? dir : resolvePath(rootDir, dir)

  return {
    ...dir,
    glob: isAbsolute(dir.glob) ? dir.glob : resolvePath(rootDir, dir.glob),
  }
}

function normalizePresetImport(
  from: string,
  entry: string | { name: string, as?: string, type?: boolean },
): Import {
  if (typeof entry === 'string')
    return { from, name: entry }

  return {
    from,
    name: entry.name,
    ...(entry.as ? { as: entry.as } : {}),
    ...(entry.type ? { type: true } : {}),
  }
}

function normalizeServerImport(entry: ServerImport): Import {
  return {
    from: entry.from,
    name: entry.name,
    ...(entry.as ? { as: entry.as } : {}),
    ...(entry.type ? { type: true } : {}),
  }
}

function resolveImportLocalName(entry: Import) {
  return entry.as || entry.name
}

function resolveDefaultImportDirs(rootDir: string, scanRoots: string[]) {
  return scanRoots.flatMap(scanRoot => [
    normalizeDir(rootDir, join(scanRoot, 'server/utils/**/*')),
    normalizeDir(rootDir, join(scanRoot, 'shared/types/**/*')),
  ])
}

function isInlinePreset(value: unknown): value is {
  from: string
  imports: unknown[]
} {
  return !!value
    && typeof value === 'object'
    && typeof (value as { from?: unknown }).from === 'string'
    && Array.isArray((value as { imports?: unknown }).imports)
}

function isPresetImport(value: unknown): value is {
  name: string
  as?: string
  type?: boolean
} {
  return !!value
    && typeof value === 'object'
    && typeof (value as { name?: unknown }).name === 'string'
}

function normalizePresetImports(presets: unknown[] = []): Import[] {
  const normalized: Import[] = []

  function collect(from: string, entry: unknown) {
    if (typeof entry === 'string') {
      normalized.push(normalizePresetImport(from, entry))
      return
    }

    if (isInlinePreset(entry)) {
      for (const nested of entry.imports)
        collect(entry.from, nested)
      return
    }

    if (isPresetImport(entry))
      normalized.push(normalizePresetImport(from, entry))
  }

  for (const preset of presets) {
    if (!isInlinePreset(preset))
      continue

    for (const entry of preset.imports)
      collect(preset.from, entry)
  }

  return normalized
}

async function createInitializedUnimport(options: DiscoveredDefinitionCompilerOptions) {
  const nitroImports = options.nitroImports !== false ? options.nitroImports : undefined
  const imports = [
    ...normalizePresetImports(nitroImports?.presets),
    ...(options.featureImports || []).map(normalizeServerImport),
  ]
  const dirs = [
    ...resolveDefaultImportDirs(options.rootDir, options.scanRoots),
    ...((nitroImports?.dirs || []).map(dir => normalizeDir(options.rootDir, dir))),
  ]

  const unimport = createUnimport({
    imports,
    dirs,
  })
  await unimport.init()
  return unimport
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

async function injectTypeImportsFromUnimport(
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

export async function createDiscoveredDefinitionCompiler(
  options: Partial<DiscoveredDefinitionCompilerOptions> = {},
): Promise<DiscoveredDefinitionCompiler> {
  const resolvedOptions: DiscoveredDefinitionCompilerOptions = {
    rootDir: options.rootDir || process.cwd(),
    scanRoots: options.scanRoots || [],
    nitroImports: options.nitroImports,
    featureImports: options.featureImports || [],
  }

  if (!isNitroAutoImportEnabled(resolvedOptions.nitroImports)) {
    return {
      enabled: false,
      async injectSource(source) {
        return source
      },
      async readSource(id) {
        return await readFile(id, 'utf8')
      },
      async bundleModule(bundleOptions) {
        return await bundleDiscoveredDefinitionModule(bundleOptions)
      },
    }
  }

  const unimport = await createInitializedUnimport(resolvedOptions)
  const injectSource = async (source: string, id: string) => {
    const valueInjected = await unimport.injectImports(source, id)
    return await injectTypeImportsFromUnimport(valueInjected.code, id, await unimport.getImports())
  }
  return {
    enabled: true,
    injectSource,
    async readSource(id) {
      return await injectSource(await readFile(id, 'utf8'), id)
    },
    async bundleModule(bundleOptions) {
      return await bundleDiscoveredDefinitionModule(bundleOptions)
    },
  }
}

export async function bundleDiscoveredDefinitionModule(options: DiscoveredDefinitionBundleOptions) {
  const result = await build({
    stdin: {
      contents: options.source,
      loader: resolveDefinitionLoader(options),
      resolveDir: dirname(options.filename),
      sourcefile: options.filename,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    logLevel: 'silent',
    jsx: isJsxDefinitionLoader(options) ? 'automatic' : undefined,
    jsxImportSource: isJsxDefinitionLoader(options) ? 'react' : undefined,
    packages: options.packages === 'external' ? 'external' : undefined,
    external: [...builtinModuleSet, ...(options.external || [])],
    plugins: options.plugins,
  })

  const output = result.outputFiles?.[0]?.text
  if (!output)
    throw new Error(`[vitehub] Failed to bundle discovered definition "${options.filename}".`)

  return output
}

export async function bundleDiscoveredDefinitionModuleGraph(
  options: DiscoveredDefinitionBundleOptions,
): Promise<DiscoveredDefinitionModuleGraph> {
  const outdir = resolvePath(dirname(options.filename), '.vitehub-discovered-definition')
  const result = await build({
    stdin: {
      contents: options.source,
      loader: resolveDefinitionLoader(options),
      resolveDir: dirname(options.filename),
      sourcefile: options.filename,
    },
    bundle: true,
    splitting: true,
    entryNames: 'definition',
    chunkNames: 'chunks/[name]-[hash]',
    outdir,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    logLevel: 'silent',
    jsx: isJsxDefinitionLoader(options) ? 'automatic' : undefined,
    jsxImportSource: isJsxDefinitionLoader(options) ? 'react' : undefined,
    packages: options.packages === 'external' ? 'external' : undefined,
    external: [...builtinModuleSet, ...(options.external || [])],
    plugins: options.plugins,
  })

  const modules = Object.fromEntries((result.outputFiles || []).map((outputFile) => {
    return [relative(outdir, outputFile.path), outputFile.text]
  }))

  if (!modules['definition.js']) {
    throw new Error(`[vitehub] Failed to bundle discovered definition graph "${options.filename}".`)
  }

  return {
    entry: 'definition.js',
    modules,
  }
}

function resolveDefinitionLoader(options: DiscoveredDefinitionBundleOptions) {
  let loader = options.loader
  if (!loader) {
    const f = options.filename
    if (f.endsWith('.tsx')) loader = 'tsx'
    else if (f.endsWith('.jsx')) loader = 'jsx'
    else if (f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.cjs')) loader = 'js'
    else loader = 'ts'
  }
  return loader
}

function isJsxDefinitionLoader(options: DiscoveredDefinitionBundleOptions) {
  const loader = resolveDefinitionLoader(options)
  return loader === 'tsx' || loader === 'jsx'
}
