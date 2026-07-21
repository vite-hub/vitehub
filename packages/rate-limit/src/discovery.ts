import { readFileSync } from "node:fs"
import { basename, relative } from "node:path"

import { listSourceFiles, resolveDefinitionScanRoots } from "@vite-hub/internal/definition-catalog"
import { parseSync, Visitor } from "vite"

import { declaredRateLimitPolicy, normalizeRateLimitPolicy, rateLimitPolicyKeys } from "./policy.ts"

import type { ESTree } from "vite"
import type { RateLimitDeclaration, RateLimitPolicy } from "./types.ts"

const rateLimitImports = new Set(["@vite-hub/rate-limit", "vite-hub/rate-limit"])
const ignoredSourceDirectories = new Set(["__tests__", "test", "tests"])
const nestedIgnoredSourceDirectories = new Set(["__tests__", "tests"])

function isApplicationSource(root: string, file: string): boolean {
  const segments = relative(root, file).split(/[\\/]/)
  if (segments.length > 1 && ignoredSourceDirectories.has(segments[0]!)) return false
  if (segments.slice(1, -1).some(segment => nestedIgnoredSourceDirectories.has(segment))) return false
  return !/\.(?:spec|test)\.(?:c|m)?[jt]sx?$/i.test(basename(file))
}

function location(source: string, offset: number): { column: number, line: number } {
  const before = source.slice(0, offset)
  const lines = before.split("\n")
  return { column: (lines.at(-1)?.length ?? 0) + 1, line: lines.length }
}

function declarationError(file: string, source: string, node: { start: number }, message: string): Error {
  const { column, line } = location(source, node.start)
  return new Error(`[vitehub] ${message}\n  at ${file}:${line}:${column}`)
}

interface RateLimitBindings {
  direct: Set<string>
  namespaces: Set<string>
}

interface RateLimitScope extends RateLimitBindings {
  shadows: Set<string>
}

function requireRateLimitBindings(program: ESTree.Program): RateLimitBindings {
  const bindings: RateLimitBindings = { direct: new Set(), namespaces: new Set() }
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || !rateLimitImports.has(statement.source.value)) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportSpecifier" && specifier.imported.type === "Identifier" && specifier.imported.name === "requireRateLimit") {
        bindings.direct.add(specifier.local.name)
      }
      if (specifier.type === "ImportNamespaceSpecifier") bindings.namespaces.add(specifier.local.name)
    }
  }
  return bindings
}

function resolveRateLimitBinding(name: string, kind: keyof RateLimitBindings, scopes: RateLimitScope[]): boolean {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const scope = scopes[index]!
    if (scope[kind].has(name)) return true
    if (scope.shadows.has(name)) return false
  }
  return false
}

function rateLimitBindingName(callee: ESTree.CallExpression["callee"], scopes: RateLimitScope[]): string | undefined {
  if (callee.type === "Identifier" && resolveRateLimitBinding(callee.name, "direct", scopes)) return callee.name
  if (callee.type !== "MemberExpression" || callee.object.type !== "Identifier" || !resolveRateLimitBinding(callee.object.name, "namespaces", scopes)) return
  const property = callee.computed
    ? callee.property.type === "Literal" ? callee.property.value : undefined
    : callee.property.type === "Identifier" ? callee.property.name : undefined
  return property === "requireRateLimit" ? callee.object.name : undefined
}

function rateLimitDynamicImport(expression: ESTree.Expression | null): boolean {
  if (!expression) return false
  const value = unwrapStaticExpression(expression)
  if (value.type !== "AwaitExpression") return false
  const imported = unwrapStaticExpression(value.argument)
  const source = imported.type === "ImportExpression" ? staticString(imported.source)?.trim() : undefined
  return Boolean(source && rateLimitImports.has(source))
}

function addDynamicRateLimitBindings(declaration: ESTree.VariableDeclaration, scope: RateLimitScope): void {
  if (declaration.kind !== "const") return
  for (const declarator of declaration.declarations) {
    if (!rateLimitDynamicImport(declarator.init)) continue
    if (declarator.id.type === "Identifier") {
      scope.shadows.delete(declarator.id.name)
      scope.namespaces.add(declarator.id.name)
      continue
    }
    if (declarator.id.type !== "ObjectPattern") continue
    for (const property of declarator.id.properties) {
      if (property.type !== "Property") continue
      const name = property.computed
        ? property.key.type === "Literal" ? property.key.value : undefined
        : property.key.type === "Identifier" ? property.key.name : undefined
      if (name !== "requireRateLimit") continue
      const value = property.value.type === "AssignmentPattern" ? property.value.left : property.value
      if (value.type !== "Identifier") continue
      scope.shadows.delete(value.name)
      scope.direct.add(value.name)
    }
  }
}

function variableDeclaration(statement: ESTree.Statement | ESTree.ModuleDeclaration): ESTree.VariableDeclaration | undefined {
  if (statement.type === "VariableDeclaration") return statement
  if (statement.type === "ExportNamedDeclaration" && statement.declaration?.type === "VariableDeclaration") return statement.declaration
}

function addDynamicRateLimitBindingsFromStatements(statements: (ESTree.Statement | ESTree.ModuleDeclaration)[], scope: RateLimitScope): void {
  for (const statement of statements) {
    const declaration = variableDeclaration(statement)
    if (declaration) addDynamicRateLimitBindings(declaration, scope)
  }
}

function addBindingNames(pattern: ESTree.BindingPattern | ESTree.ParamPattern, names: Set<string>): void {
  if (pattern.type === "Identifier") {
    names.add(pattern.name)
    return
  }
  if (pattern.type === "TSParameterProperty") {
    addBindingNames(pattern.parameter, names)
    return
  }
  if (pattern.type === "RestElement") {
    addBindingNames(pattern.argument, names)
    return
  }
  if (pattern.type === "AssignmentPattern") {
    addBindingNames(pattern.left, names)
    return
  }
  if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements) {
      if (element) addBindingNames(element, names)
    }
    return
  }
  for (const property of pattern.properties) {
    addBindingNames(property.type === "RestElement" ? property.argument : property.value, names)
  }
}

function functionBindings(params: ESTree.ParamPattern[]): Set<string> {
  const names = new Set<string>()
  for (const parameter of params) addBindingNames(parameter, names)
  return names
}

function variableBindings(declaration: ESTree.VariableDeclaration | null | undefined): Set<string> {
  const names = new Set<string>()
  for (const declarator of declaration?.declarations ?? []) addBindingNames(declarator.id, names)
  return names
}

function blockBindings(block: ESTree.BlockStatement): Set<string> {
  const names = new Set<string>()
  for (const statement of block.body) {
    if ((statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") && statement.id) {
      names.add(statement.id.name)
    }
    const declaration = statement.type === "VariableDeclaration"
      ? statement
      : statement.type === "ExportNamedDeclaration" && statement.declaration?.type === "VariableDeclaration"
        ? statement.declaration
        : undefined
    for (const declarator of declaration?.declarations ?? []) addBindingNames(declarator.id, names)
  }
  return names
}

function switchBindings(statement: ESTree.SwitchStatement): Set<string> {
  const names = new Set<string>()
  for (const switchCase of statement.cases) {
    for (const child of switchCase.consequent) {
      if ((child.type === "FunctionDeclaration" || child.type === "ClassDeclaration") && child.id) names.add(child.id.name)
      if (child.type === "VariableDeclaration") {
        for (const name of variableBindings(child)) names.add(name)
      }
    }
  }
  return names
}

function staticPropertyName(property: ESTree.ObjectProperty): string | undefined {
  if (property.computed || property.kind !== "init" || property.method) return
  if (property.key.type === "Identifier") return property.key.name
  if (property.key.type === "Literal" && typeof property.key.value === "string") return property.key.value
}

function unwrapStaticExpression(expression: ESTree.Expression): ESTree.Expression {
  while (expression.type === "TSAsExpression" || expression.type === "TSSatisfiesExpression" || expression.type === "TSNonNullExpression") {
    expression = expression.expression
  }
  return expression
}

function staticString(expression: ESTree.Expression): string | undefined {
  const value = unwrapStaticExpression(expression)
  if (value.type === "Literal" && typeof value.value === "string") return value.value
  if (value.type === "TemplateLiteral" && value.expressions.length === 0) return value.quasis[0]?.value.cooked ?? value.quasis[0]?.value.raw
}

function staticPolicy(call: ESTree.CallExpression, file: string, source: string): RateLimitPolicy {
  const policyArgument = call.arguments[2]
  const policyNode = policyArgument?.type === "SpreadElement" ? policyArgument : policyArgument && unwrapStaticExpression(policyArgument)
  if (!policyNode || policyNode.type !== "ObjectExpression") {
    throw declarationError(file, source, call, "`requireRateLimit()` requires a static options object as its third argument.")
  }

  const values = new Map<string, string | number>()
  for (const property of policyNode.properties) {
    if (property.type !== "Property") {
      throw declarationError(file, source, property, "`requireRateLimit()` options cannot use object spreads.")
    }
    const name = staticPropertyName(property)
    if (name === "key") continue
    if (!name || !rateLimitPolicyKeys.has(name)) {
      throw declarationError(file, source, property, `\`requireRateLimit()\` does not support the ${name ? `"${name}"` : "dynamic"} option.`)
    }
    const value = unwrapStaticExpression(property.value)
    const literal = value.type === "Literal" && typeof value.value === "number" ? value.value : staticString(value)
    if (literal === undefined) {
      throw declarationError(file, source, property.value, `\`requireRateLimit()\` policy option "${name}" must be a static literal.`)
    }
    values.set(name, literal)
  }

  const policy = {
    ...(values.has("enforcement") ? { enforcement: values.get("enforcement") } : {}),
    ...(values.has("failure") ? { failure: values.get("failure") } : {}),
    limit: values.get("limit"),
    window: values.get("window"),
  } as RateLimitPolicy

  try {
    return declaredRateLimitPolicy(normalizeRateLimitPolicy(policy))
  }
  catch (error) {
    throw declarationError(file, source, policyNode, error instanceof Error ? error.message : String(error))
  }
}

export function extractRateLimitDeclarations(file: string, source: string): RateLimitDeclaration[] {
  if (!source.includes("requireRateLimit")) return []
  const parsed = parseSync(file, source)
  if (parsed.errors.length > 0) {
    throw new Error(`[vitehub] Could not parse ${file} while collecting Rate Limits: ${parsed.errors[0]?.message}`)
  }

  const bindings = requireRateLimitBindings(parsed.program)
  const declarations: RateLimitDeclaration[] = []
  const scopes: RateLimitScope[] = [{ ...bindings, shadows: new Set() }]
  addDynamicRateLimitBindingsFromStatements(parsed.program.body, scopes[0]!)
  const enterScope = (shadows: Set<string>): void => {
    scopes.push({ direct: new Set(), namespaces: new Set(), shadows })
  }
  const enterFunction = (node: ESTree.Function | ESTree.ArrowFunctionExpression): void => {
    const shadows = functionBindings(node.params)
    if (node.type === "FunctionExpression" && node.id) shadows.add(node.id.name)
    enterScope(shadows)
  }
  const exitScope = (): void => {
    scopes.pop()
  }
  const visitor = new Visitor({
    ArrowFunctionExpression: enterFunction,
    "ArrowFunctionExpression:exit": exitScope,
    BlockStatement(block) {
      enterScope(blockBindings(block))
      addDynamicRateLimitBindingsFromStatements(block.body, scopes.at(-1)!)
    },
    "BlockStatement:exit": exitScope,
    CatchClause(clause) {
      const names = new Set<string>()
      if (clause.param) addBindingNames(clause.param, names)
      enterScope(names)
    },
    "CatchClause:exit": exitScope,
    ClassExpression(node) {
      enterScope(new Set(node.id ? [node.id.name] : []))
    },
    "ClassExpression:exit": exitScope,
    CallExpression(call) {
      const calleeName = rateLimitBindingName(call.callee, scopes)
      if (!calleeName) return
      if (call.arguments.length !== 3) {
        throw declarationError(file, source, call, "`requireRateLimit()` requires an event, a stable ID, and a static options object.")
      }
      const idNode = call.arguments[1]
      const staticId = idNode?.type === "SpreadElement" ? undefined : idNode && staticString(idNode)
      if (!staticId?.trim()) {
        throw declarationError(file, source, idNode ?? call, "`requireRateLimit()` requires a non-empty static string ID.")
      }
      const id = staticId.trim()
      const sourceLocation = location(source, call.start)
      declarations.push({
        name: id,
        policy: staticPolicy(call, file, source),
        source: { file, ...sourceLocation },
      })
    },
    FunctionDeclaration: enterFunction,
    "FunctionDeclaration:exit": exitScope,
    FunctionExpression: enterFunction,
    "FunctionExpression:exit": exitScope,
    ForInStatement(node) {
      enterScope(node.left.type === "VariableDeclaration" ? variableBindings(node.left) : new Set())
    },
    "ForInStatement:exit": exitScope,
    ForOfStatement(node) {
      enterScope(node.left.type === "VariableDeclaration" ? variableBindings(node.left) : new Set())
    },
    "ForOfStatement:exit": exitScope,
    ForStatement(node) {
      enterScope(node.init?.type === "VariableDeclaration" ? variableBindings(node.init) : new Set())
    },
    "ForStatement:exit": exitScope,
    SwitchStatement(node) {
      enterScope(switchBindings(node))
      for (const switchCase of node.cases) addDynamicRateLimitBindingsFromStatements(switchCase.consequent, scopes.at(-1)!)
    },
    "SwitchStatement:exit": exitScope,
  })
  visitor.visit(parsed.program)
  return declarations
}

export function discoverRateLimitCatalog(options: { rootDir: string, scanDirs?: string[] }): { declarationFiles: Set<string>, declarations: RateLimitDeclaration[] } {
  const declarations = new Map<string, RateLimitDeclaration>()
  const sourceFiles = new Set(resolveDefinitionScanRoots(options.rootDir, options.scanDirs)
    .flatMap(root => listSourceFiles(root).filter(file => isApplicationSource(root, file))))
  const declarationFiles = new Set<string>()
  for (const file of sourceFiles) {
    const source = readFileSync(file, "utf8")
    const extracted = extractRateLimitDeclarations(file, source)
    if (extracted.length > 0) declarationFiles.add(file)
    for (const declaration of extracted) {
      const existing = declarations.get(declaration.name)
      if (existing && JSON.stringify(existing.policy) !== JSON.stringify(declaration.policy)) {
        throw new Error([
          `[vitehub] Conflicting Rate Limit policies for ID "${declaration.name}":`,
          `  - ${existing.source.file}:${existing.source.line}:${existing.source.column} ${JSON.stringify(existing.policy)}`,
          `  - ${declaration.source.file}:${declaration.source.line}:${declaration.source.column} ${JSON.stringify(declaration.policy)}`,
        ].join("\n"))
      }
      if (!existing) declarations.set(declaration.name, declaration)
    }
  }
  return {
    declarationFiles,
    declarations: [...declarations.values()].sort((left, right) => left.name.localeCompare(right.name)),
  }
}

export function discoverRateLimitDeclarations(options: { rootDir: string, scanDirs?: string[] }): RateLimitDeclaration[] {
  return discoverRateLimitCatalog(options).declarations
}
