import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

import ts from "typescript"

/** One code of a package catalog, with the text that the docs can show without running the code. */
export interface DiagnosticCode {
  code: string
  /** Package folder, such as `queue`. */
  pkg: string
  /** Catalog file, relative to the repository root. */
  file: string
  line: number
  /** `why` as a template: `${name}` becomes `<name>`. `null` when the call site passes the message. */
  why: string | null
  fix: string | null
  /** The comment above the code in the catalog, such as `Runtime errors`. */
  group: string | null
  /** The catalog's `docsBase` or `docs` URL when it is a string. */
  docsBase: string | null
  /** A per-code `docs` URL that overrides the catalog base. */
  docs: string | null
  /** Where the code is raised, and the message that each call site passes. */
  sites: DiagnosticSite[]
}

export interface DiagnosticSite {
  file: string
  line: number
  message: string | null
}

/** One `codes` object of a catalog call, with its codes in source order. */
export interface DiagnosticCatalog {
  /** Catalog file, relative to the repository root. */
  file: string
  codes: DiagnosticCode[]
}

const catalogCalls = new Set(["defineErrors", "defineDiagnostics", "defineProdDiagnostics"])
const codePattern = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/
const declaresCatalog = /define(?:Errors|Diagnostics|ProdDiagnostics)\(/
const mayHoldDiagnostics = /define(?:Errors|Diagnostics|ProdDiagnostics)\(|[.["'][A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+["\]]?\s*\(/

/** Every code of every catalog under `packages/*\/src`, with its call sites. */
export function readDiagnosticCodes(root: string): DiagnosticCode[] {
  const { sources, catalogs } = readCatalogs(root)
  const codes = new Map<string, DiagnosticCode>()
  for (const catalog of catalogs) {
    for (const code of catalog.codes) {
      const existing = codes.get(code.code)
      // A package can declare another package's code again, such as CMS for Content. The catalog of the package that
      // the code prefix names wins, and keeps the other's text where its own has none.
      if (existing) {
        const [owner, other] = owns(code) && !owns(existing) ? [code, existing] : [existing, code]
        codes.set(code.code, { ...owner, why: owner.why ?? other.why, fix: owner.fix ?? other.fix, group: owner.group ?? other.group, docsBase: owner.docsBase ?? other.docsBase })
        continue
      }
      codes.set(code.code, code)
    }
  }
  for (const { file, source } of sources) {
    visit(source, (node) => {
      if (!ts.isCallExpression(node)) return
      const callee = node.expression
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : null
      const code = name ? codes.get(name) : undefined
      if (!code) return
      const [argument] = node.arguments
      code.sites.push({ file: relative(root, file), line: lineOf(source, node), message: argument && ts.isObjectLiteralExpression(argument) ? messageOf(argument) : null })
    })
  }
  return [...codes.values()].sort((left, right) => left.code.localeCompare(right.code))
}

/** Every catalog under `packages/*\/src`, without call sites. A code that two catalogs declare is in both. */
export function readDiagnosticCatalogs(root: string): DiagnosticCatalog[] {
  return readCatalogs(root).catalogs
}

function readCatalogs(root: string): { sources: { file: string, source: ts.SourceFile }[], catalogs: DiagnosticCatalog[] } {
  // Most files neither define a catalog nor raise a code. Parse only those that can.
  const texts = packageSources(root)
    .map(file => ({ file, text: readFileSync(file, "utf8") }))
    .filter(({ text }) => mayHoldDiagnostics.test(text))
  // A code prefix names its owner only when that package declares a catalog, so a package such as the Console app
  // does not take the `CONSOLE_*` codes of vite-hub.
  const packages = new Set(texts.filter(({ text }) => declaresCatalog.test(text)).map(({ file }) => relative(join(root, "packages"), file).split(/[\\/]/)[0]!))
  const sources = texts.map(({ file, text }) => ({ file, source: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true) }))
  return { sources, catalogs: sources.flatMap(({ file, source }) => fileCatalogs(root, file, source, packages)) }
}

function owns(code: DiagnosticCode): boolean {
  return code.file.startsWith(`packages/${code.pkg}/`)
}

/** Numbered diagnostics name their owner package; named runtime errors belong to their declaring catalog. */
function ownerPackage(code: string, packages: ReadonlySet<string>): string | null {
  if (!/_[A-Z]\d{4}$/.test(code)) return null
  const parts = code.toLowerCase().split("_").slice(0, -1)
  for (let length = parts.length; length > 0; length--) {
    const name = parts.slice(0, length).join("-")
    if (packages.has(name)) return name
  }
  return null
}

/**
 * The text that a catalog helper call passes as its `why` or `fix` parameter, such as `guidance("Retry.")` or
 * `code(why, fix, docs, action)`. The helper must be a function of the same file. Only literal arguments count.
 */
function helperText(value: ts.Expression, key: "why" | "fix"): string | null {
  if (!ts.isCallExpression(value) || !ts.isIdentifier(value.expression)) return null
  const index = helperParameters(value.expression)?.findIndex(parameter => ts.isIdentifier(parameter.name) && parameter.name.text === key) ?? -1
  const argument = index < 0 ? undefined : value.arguments[index]
  return argument && (ts.isStringLiteralLike(argument) || ts.isTemplateExpression(argument)) ? templateText(argument) : null
}

/** The parameters of a same-file function declaration or of a variable that holds an arrow or function expression. */
function helperParameters(name: ts.Identifier): ts.NodeArray<ts.ParameterDeclaration> | null {
  for (let scope = name.parent; scope; scope = scope.parent) {
    if (!ts.isSourceFile(scope) && !ts.isBlock(scope)) continue
    for (const statement of scope.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name.text) return statement.parameters
      if (!ts.isVariableStatement(statement)) continue
      const initializer = statement.declarationList.declarations.find(candidate => ts.isIdentifier(candidate.name) && candidate.name.text === name.text)?.initializer
      if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) return initializer.parameters
    }
  }
  return null
}

function packageSources(root: string): string[] {
  const packages = join(root, "packages")
  return readdirSync(packages, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap((entry) => {
      const src = join(packages, entry.name, "src")
      try {
        return readdirSync(src, { recursive: true, withFileTypes: true })
          .filter(file => file.isFile() && /\.(?:ts|mts)$/.test(file.name) && !file.name.endsWith(".d.ts") && !/\.(?:test|spec)\./.test(file.name))
          .map(file => join(file.parentPath, file.name))
      }
      catch {
        return []
      }
    })
    .sort()
}

function fileCatalogs(root: string, file: string, source: ts.SourceFile, packages: ReadonlySet<string>): DiagnosticCatalog[] {
  const catalogs: DiagnosticCatalog[] = []
  const declaring = relative(join(root, "packages"), file).split(/[\\/]/)[0]!
  visit(source, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || !catalogCalls.has(node.expression.text)) return
    // Factory implementations forward caller-owned codes; their call sites define the catalogs.
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isFunctionDeclaration(parent) && parent.name && catalogCalls.has(parent.name.text)) return
    }
    const options = objectValue(node.arguments[0])
    if (!options) throw new Error(`Cannot read diagnostic options in ${relative(root, file)}:${lineOf(source, node)}. Use a same-file object literal.`)
    const docsBase = stringValue(source, options.properties.find(property => ["docs", "docsBase"].includes(propertyName(property) ?? "")))
    const codesProperty = options.properties.find(property => propertyName(property) === "codes")
    const codes = objectValue(propertyValue(codesProperty))
    if (!codes) throw new Error(`Cannot read diagnostic codes in ${relative(root, file)}:${lineOf(source, node)}. Use a same-file object literal.`)
    const found: DiagnosticCode[] = []
    let group: string | null = null
    for (const property of codes.properties) {
      const code = propertyName(property)
      if (!code || !codePattern.test(code) || !ts.isPropertyAssignment(property)) continue
      group = commentGroup(source, property) ?? group
      const definition = objectValue(property.initializer)
      found.push({
        code,
        pkg: ownerPackage(code, packages) ?? declaring,
        file: relative(root, file),
        line: lineOf(source, property),
        why: definition ? textOf(definition, "why") : helperText(property.initializer, "why"),
        fix: definition ? textOf(definition, "fix") : helperText(property.initializer, "fix"),
        group,
        docsBase,
        docs: definition ? stringValue(source, definition.properties.find(property => propertyName(property) === "docs")) : null,
        sites: [],
      })
    }
    catalogs.push({ file: relative(root, file), codes: found })
  })
  return catalogs
}

/** Resolve literal objects and same-file variable references in their enclosing block or source file. */
function objectValue(value: ts.Expression | undefined, seen = new Set<ts.Expression>()): ts.ObjectLiteralExpression | null {
  if (!value || seen.has(value)) return null
  seen.add(value)
  if (ts.isObjectLiteralExpression(value)) return value
  if (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isTypeAssertionExpression(value) || ts.isNonNullExpression(value)) return objectValue(value.expression, seen)
  if (!ts.isIdentifier(value)) return null
  for (let scope = value.parent; scope; scope = scope.parent) {
    if (!ts.isSourceFile(scope) && !ts.isBlock(scope)) continue
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement)) continue
      const declaration = statement.declarationList.declarations.find(candidate => ts.isIdentifier(candidate.name) && candidate.name.text === value.text)
      if (declaration) return objectValue(declaration.initializer, seen)
    }
  }
  return null
}

function propertyValue(property: ts.ObjectLiteralElementLike | undefined): ts.Expression | undefined {
  if (property && ts.isPropertyAssignment(property)) return property.initializer
  if (property && ts.isShorthandPropertyAssignment(property)) return property.name
  return undefined
}

/** A `// Runtime errors. ...` comment above a code starts a group. Only its first sentence names the group. */
function commentGroup(source: ts.SourceFile, node: ts.Node): string | null {
  const ranges = ts.getLeadingCommentRanges(source.text, node.pos) ?? []
  const comment = ranges.map(range => source.text.slice(range.pos, range.end)).filter(text => text.startsWith("//")).at(0)
  if (!comment) return null
  const sentence = comment.replace(/^\/\/\s*/, "").split(/\.(?:\s|$)/)[0]!.trim()
  return /^[A-Z][\w -]{2,40}$/.test(sentence) && /errors?$|diagnostics?$/i.test(sentence) ? sentence : null
}

/** The text of `why` or `fix`: a string, or the most detailed string that a function can return. */
function textOf(definition: ts.ObjectLiteralExpression, key: "why" | "fix"): string | null {
  const property = definition.properties.find(candidate => propertyName(candidate) === key)
  if (!property || !ts.isPropertyAssignment(property)) return null
  const strings: string[] = []
  visit(property.initializer, (node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) strings.push(templateText(node))
  })
  // `message === undefined ? "" : String(message)` passes the message of the call site.
  const best = strings.filter(text => text.trim().length > 0).sort((left, right) => placeholders(right) - placeholders(left) || right.length - left.length)[0]
  return best ?? null
}

function placeholders(text: string): number {
  return text.match(/<[^>]+>/g)?.length ?? 0
}

/** The `message` that a call site passes: a string or a template, with each `${expression}` as `<expression>`. */
function messageOf(argument: ts.ObjectLiteralExpression): string | null {
  const property = argument.properties.find(candidate => propertyName(candidate) === "message")
  if (!property || !ts.isPropertyAssignment(property)) return null
  const value = property.initializer
  return ts.isStringLiteralLike(value) || ts.isTemplateExpression(value) ? templateText(value) : null
}

function templateText(node: ts.StringLiteralLike | ts.TemplateExpression): string {
  if (!ts.isTemplateExpression(node)) return node.text
  return node.head.text + node.templateSpans.map(span => `<${placeholderName(span.expression)}>${span.literal.text}`).join("")
}

/** `options.binding` is `binding`, and `String(name)` is `name`. Anything else is `value`. */
function placeholderName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  if (ts.isCallExpression(expression) && expression.arguments.length === 1) return placeholderName(expression.arguments[0]!)
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) return placeholderName(expression.expression)
  return "value"
}

/** A string property, or a shorthand `docs` that names a string constant of the same file. */
function stringValue(source: ts.SourceFile, property: ts.ObjectLiteralElementLike | undefined): string | null {
  if (!property) return null
  const value = ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : null
  if (!value) return null
  if (ts.isStringLiteralLike(value)) return value.text
  if (!ts.isIdentifier(value)) return null
  let found: string | null = null
  visit(source, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === value.text && node.initializer && ts.isStringLiteralLike(node.initializer)) found = node.initializer.text
  })
  return found
}

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
  const name = property.name
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  return null
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node)
  ts.forEachChild(node, child => visit(child, callback))
}
