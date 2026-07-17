import { readFileSync } from "node:fs"
import { basename, relative } from "node:path"

import { listSourceFiles, resolveDefinitionScanRoots } from "@vite-hub/internal/definition-catalog"
import { parseSync, Visitor } from "vite"

import { declaredRateLimitPolicy, normalizeRateLimitPolicy, rateLimitPolicyKeys } from "./policy.ts"

import type { ESTree } from "vite"
import type { RateLimitDeclaration, RateLimitPolicy } from "./types.ts"

const rateLimitImports = new Set(["@vite-hub/rate-limit", "vite-hub/rate-limit"])
const ignoredSourceDirectories = new Set(["__tests__", "examples", "fixtures", "test", "tests"])
const nestedIgnoredSourceDirectories = new Set(["__tests__", "examples", "fixtures", "tests"])

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

function defineRateLimitBindings(program: ESTree.Program): Set<string> {
  const bindings = new Set<string>()
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || !rateLimitImports.has(statement.source.value)) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportSpecifier" && specifier.imported.type === "Identifier" && specifier.imported.name === "defineRateLimit") {
        bindings.add(specifier.local.name)
      }
    }
  }
  return bindings
}

function topLevelCalls(program: ESTree.Program, bindings: Set<string>): Set<number> {
  const calls = new Set<number>()
  for (const statement of program.body) {
    const declaration = statement.type === "VariableDeclaration"
      ? statement
      : statement.type === "ExportNamedDeclaration" && statement.declaration?.type === "VariableDeclaration"
        ? statement.declaration
        : undefined
    if (!declaration || declaration.kind !== "const") continue
    for (const declarator of declaration.declarations) {
      const init = declarator.init
      if (init?.type === "CallExpression" && init.callee.type === "Identifier" && bindings.has(init.callee.name)) {
        calls.add(init.start)
      }
    }
  }
  return calls
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

function staticPolicy(call: ESTree.CallExpression, file: string, source: string): RateLimitPolicy {
  const policyArgument = call.arguments[1]
  const policyNode = policyArgument?.type === "SpreadElement" ? policyArgument : policyArgument && unwrapStaticExpression(policyArgument)
  if (!policyNode || policyNode.type !== "ObjectExpression") {
    throw declarationError(file, source, call, "`defineRateLimit()` requires a static policy object as its second argument.")
  }

  const values = new Map<string, string | number>()
  for (const property of policyNode.properties) {
    if (property.type !== "Property") {
      throw declarationError(file, source, property, "`defineRateLimit()` policies cannot use object spreads.")
    }
    const name = staticPropertyName(property)
    if (!name || !rateLimitPolicyKeys.has(name)) {
      throw declarationError(file, source, property, `\`defineRateLimit()\` does not support the ${name ? `"${name}"` : "dynamic"} policy option.`)
    }
    const value = unwrapStaticExpression(property.value)
    if (value.type !== "Literal" || (typeof value.value !== "string" && typeof value.value !== "number")) {
      throw declarationError(file, source, property.value, `\`defineRateLimit()\` policy option "${name}" must be a static literal.`)
    }
    values.set(name, value.value)
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
  if (!source.includes("defineRateLimit")) return []
  const parsed = parseSync(file, source)
  if (parsed.errors.length > 0) {
    throw new Error(`[vitehub] Could not parse ${file} while collecting Rate Limits: ${parsed.errors[0]?.message}`)
  }

  const bindings = defineRateLimitBindings(parsed.program)
  if (bindings.size === 0) return []
  const allowedCalls = topLevelCalls(parsed.program, bindings)
  const declarations: RateLimitDeclaration[] = []
  const localBindings: Set<string>[] = []
  const enterFunction = (node: ESTree.Function | ESTree.ArrowFunctionExpression): void => {
    const bindings = functionBindings(node.params)
    if (node.type === "FunctionExpression" && node.id) bindings.add(node.id.name)
    localBindings.push(bindings)
  }
  const exitScope = (): void => {
    localBindings.pop()
  }
  const visitor = new Visitor({
    ArrowFunctionExpression: enterFunction,
    "ArrowFunctionExpression:exit": exitScope,
    BlockStatement(block) {
      localBindings.push(blockBindings(block))
    },
    "BlockStatement:exit": exitScope,
    CatchClause(clause) {
      const names = new Set<string>()
      if (clause.param) addBindingNames(clause.param, names)
      localBindings.push(names)
    },
    "CatchClause:exit": exitScope,
    ClassExpression(node) {
      localBindings.push(new Set(node.id ? [node.id.name] : []))
    },
    "ClassExpression:exit": exitScope,
    CallExpression(call) {
      if (call.callee.type !== "Identifier" || !bindings.has(call.callee.name)) return
      const calleeName = call.callee.name
      if (localBindings.some(scope => scope.has(calleeName))) return
      if (!allowedCalls.has(call.start)) {
        throw declarationError(file, source, call, "`defineRateLimit()` must be assigned directly to a top-level `const`.")
      }
      if (call.arguments.length !== 2) {
        throw declarationError(file, source, call, "`defineRateLimit()` requires a stable ID and a static policy object.")
      }
      const idNode = call.arguments[0]
      if (idNode?.type !== "Literal" || typeof idNode.value !== "string" || !idNode.value.trim()) {
        throw declarationError(file, source, idNode ?? call, "`defineRateLimit()` requires a non-empty static string ID.")
      }
      const id = idNode.value.trim()
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
      localBindings.push(node.left.type === "VariableDeclaration" ? variableBindings(node.left) : new Set())
    },
    "ForInStatement:exit": exitScope,
    ForOfStatement(node) {
      localBindings.push(node.left.type === "VariableDeclaration" ? variableBindings(node.left) : new Set())
    },
    "ForOfStatement:exit": exitScope,
    ForStatement(node) {
      localBindings.push(node.init?.type === "VariableDeclaration" ? variableBindings(node.init) : new Set())
    },
    "ForStatement:exit": exitScope,
    SwitchStatement(node) {
      localBindings.push(switchBindings(node))
    },
    "SwitchStatement:exit": exitScope,
  })
  visitor.visit(parsed.program)
  return declarations
}

export function discoverRateLimitDeclarations(options: { rootDir: string, scanDirs?: string[] }): RateLimitDeclaration[] {
  const declarations = new Map<string, RateLimitDeclaration>()
  const files = new Set(resolveDefinitionScanRoots(options.rootDir, options.scanDirs)
    .flatMap(root => listSourceFiles(root).filter(file => isApplicationSource(root, file))))
  for (const file of files) {
    const source = readFileSync(file, "utf8")
    for (const declaration of extractRateLimitDeclarations(file, source)) {
      const existing = declarations.get(declaration.name)
      if (existing) {
        throw new Error([
          `[vitehub] Duplicate Rate Limit ID "${declaration.name}":`,
          `  - ${existing.source.file}:${existing.source.line}:${existing.source.column}`,
          `  - ${declaration.source.file}:${declaration.source.line}:${declaration.source.column}`,
        ].join("\n"))
      }
      declarations.set(declaration.name, declaration)
    }
  }
  return [...declarations.values()].sort((left, right) => left.name.localeCompare(right.name))
}
