import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

import { keyName, line, parseProgram, start, walk } from "@vite-hub/internal/ast"

import { bindingResolver } from "./binding-resolver.ts"
import { unwrapExpression } from "./nuxt-config.ts"

import type { File, Identifier, Node, ObjectExpression } from "@babel/types"
import type { FollowUp } from "../types.ts"

const extensions = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]

function resolveRelativeImport(cwd: string, importer: string, source: string): string | undefined {
  const base = resolve(cwd, dirname(importer), source)
  const fallback = base.replace(/\.(m|c)?js$/, (_, prefix: string | undefined) => `.${prefix ?? ""}ts`)
  const candidates = [base, fallback, ...extensions.map(extension => `${base}${extension}`), ...extensions.map(extension => join(base, `index${extension}`))]
  const file = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile())
  if (!file) return
  const path = relative(cwd, file).replaceAll("\\", "/")
  return path.startsWith("..") || isAbsolute(path) || path.split("/").includes("node_modules") ? undefined : path
}

function readModule(cwd: string, file: string) {
  const code = readFileSync(join(cwd, file), "utf8")
  const program = parseProgram(code, { jsx: /\.[jt]sx$/.test(file), typescript: !/\.(?:c|m)?jsx?$/.test(file) })
  const binding = bindingResolver(program)
  const values = new Map<Identifier, Node>()
  const imports = new Map<Identifier, { source: string, name: string }>()
  const exports = new Map<string, Node>()
  walk(program, (node, ancestors) => {
    const parent = ancestors.at(-1)
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init && parent?.type === "VariableDeclaration" && parent.kind === "const") values.set(node.id, node.init)
    if (node.type === "FunctionDeclaration" && node.id) values.set(node.id, node)
  })
  for (const statement of program.program.body) {
    if (statement.type === "ImportDeclaration" && statement.importKind !== "type") {
      for (const specifier of statement.specifiers) {
        const name = specifier.type === "ImportDefaultSpecifier" ? "default"
          : specifier.type === "ImportSpecifier" && specifier.importKind !== "type" ? keyName(specifier.imported) : undefined
        if (name) imports.set(specifier.local, { source: statement.source.value, name })
      }
    }
    else if (statement.type === "ExportDefaultDeclaration") exports.set("default", statement.declaration)
    else if (statement.type === "ExportNamedDeclaration" && !statement.source && statement.exportKind !== "type") {
      const { declaration } = statement
      if (declaration?.type === "FunctionDeclaration" && declaration.id) exports.set(declaration.id.name, declaration)
      if (declaration?.type === "VariableDeclaration" && declaration.kind === "const") {
        for (const item of declaration.declarations) {
          if (item.id.type === "Identifier" && item.init) exports.set(item.id.name, item.init)
        }
      }
      for (const specifier of statement.specifiers) {
        if (specifier.type !== "ExportSpecifier") continue
        const name = keyName(specifier.exported)
        if (name) exports.set(name, specifier.local)
      }
    }
  }
  return { file, program, binding, values, imports, exports }
}

type SourceModule = ReturnType<typeof readModule>
interface Value { module: SourceModule, node: Node }

function propertyValue(object: ObjectExpression, name: string): Node | undefined {
  for (let index = object.properties.length - 1; index >= 0; index--) {
    const property = object.properties[index]!
    if (property.type === "SpreadElement") return undefined
    const key = keyName(property.key, property.computed)
    if (key === undefined) return undefined
    if (key === name) return property.type === "ObjectProperty" ? property.value : undefined
  }
}

function returnedValue(fn: Node): Node | undefined {
  if (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression" && fn.type !== "FunctionDeclaration") return
  if (fn.async || fn.generator) return
  if (fn.body.type !== "BlockStatement") return fn.body
  const last = fn.body.body.at(-1)
  if (last?.type === "ReturnStatement" && fn.body.body.slice(0, -1).every(statement => statement.type === "VariableDeclaration" && statement.kind === "const")) return last.argument ?? undefined
}

/** Trace only options consumed by the config, crossing at most one relative import. */
export function importedConfigOptions(
  cwd: string,
  configFiles: readonly string[],
  findRoot: (program: File, file: string) => ObjectExpression | undefined,
): { options: Map<string, Set<number>>, followUps: FollowUp[] } {
  const modules = new Map<string, SourceModule | undefined>()
  const options = new Map<string, Set<number>>()
  const followUps: FollowUp[] = []
  const load = (file: string) => {
    if (!modules.has(file)) {
      try {
        modules.set(file, readModule(cwd, file))
      }
      catch {
        modules.set(file, undefined)
      }
    }
    return modules.get(file)
  }

  for (const file of configFiles) {
    const config = load(file)
    const root = config && findRoot(config.program, file)
    if (!config || !root) continue
    const active = new Set<Node>()
    const trace = (module: SourceModule, input: Node): Value | undefined => {
      const node = unwrapExpression(input)
      if (active.has(node)) return undefined
      active.add(node)
      const result = readValue(module, node)
      active.delete(node)
      return result
    }
    const readValue = (module: SourceModule, node: Node): Value | undefined => {
      if (node.type === "Identifier") {
        const binding = module.binding(node)
        if (!binding) return
        const local = module.values.get(binding)
        if (local) return trace(module, local)
        const imported = module === config ? module.imports.get(binding) : undefined
        if (!imported || !/^\.\.?\//.test(imported.source)) return
        const path = resolveRelativeImport(cwd, file, imported.source)
        const target = path && !configFiles.includes(path) ? load(path) : undefined
        const exported = target?.exports.get(imported.name)
        if (target && exported) return trace(target, exported)
        return
      }
      if (node.type === "MemberExpression") {
        const name = keyName(node.property, node.computed)
        if (name === undefined) return
        const object = trace(module, node.object)
        const value = object?.node.type === "ObjectExpression" ? propertyValue(object.node, name) : undefined
        if (object && value) return trace(object.module, value)
        return
      }
      if (node.type === "CallExpression") {
        const callee = trace(module, node.callee)
        const returned = callee && returnedValue(callee.node)
        if (callee && returned) return trace(callee.module, returned)
        return
      }
      return { module, node }
    }

    const follow = (input: Node) => {
      const item = { file, line: line(input), message: "The codemod could not trace these vite-hub options to an object literal. Check and migrate them by hand." }
      if (!followUps.some(entry => entry.file === item.file && entry.line === item.line)) followUps.push(item)
    }
    const collect = (module: SourceModule, input: Node | undefined, origin = input) => {
      if (!input) return
      const result = trace(module, input)
      if (result?.node.type === "ObjectExpression") {
        if (result.module === config) return
        const positions = options.get(result.module.file) ?? new Set<number>()
        positions.add(start(result.node))
        options.set(result.module.file, positions)
      }
      else if (origin && result?.node.type !== "BooleanLiteral") follow(origin)
    }

    if (/^(?:.*\/)?vite\.config\./.test(file)) {
      const plugins = propertyValue(root, "plugins")
      const resolved = plugins && trace(config, plugins)
      if (!resolved || resolved.module !== config || resolved.node.type !== "ArrayExpression") continue
      for (const entry of resolved.node.elements) {
        if (!entry) continue
        const call = unwrapExpression(entry)
        if (call.type !== "CallExpression" || call.callee.type !== "Identifier") continue
        const binding = config.binding(call.callee)
        const imported = binding && config.imports.get(binding)
        if (imported?.source === "vite-hub" && imported.name === "vitehub") collect(config, call.arguments[0])
      }
    }
    else {
      const scopeOptions = (module: SourceModule, scope: ObjectExpression, origin?: Node) => {
        collect(module, propertyValue(scope, "vitehub"), origin)
        const modules = propertyValue(scope, "modules")
        const entries = modules && unwrapExpression(modules)
        if (entries?.type !== "ArrayExpression") return
        for (const element of entries.elements) {
          if (!element) continue
          const tuple = unwrapExpression(element)
          if (tuple.type !== "ArrayExpression" || !tuple.elements[0]) continue
          const head = unwrapExpression(tuple.elements[0])
          const binding = head.type === "Identifier" && module.binding(head)
          const imported = binding && module.imports.get(binding)
          if ((head.type === "StringLiteral" && head.value === "vite-hub/nuxt") || (imported && imported.source === "vite-hub/nuxt" && imported.name === "default")) {
            collect(module, tuple.elements[1] ?? undefined, origin)
          }
        }
      }
      const override = (module: SourceModule, input: Node, origin: Node, named: boolean) => {
        const scope = trace(module, input)
        if (scope?.node.type !== "ObjectExpression") return follow(origin)
        if (!named) return scopeOptions(scope.module, scope.node, origin)
        for (const entry of scope.node.properties) {
          if (entry.type !== "ObjectProperty") continue
          const value = trace(scope.module, entry.value)
          if (value?.node.type === "ObjectExpression") scopeOptions(value.module, value.node, origin)
          else follow(origin)
        }
      }
      scopeOptions(config, root)
      for (const entry of root.properties) {
        if (entry.type !== "ObjectProperty") continue
        const name = keyName(entry.key, entry.computed)
        if (name?.startsWith("$") && propertyValue(root, name) === entry.value) override(config, entry.value, entry.value, name === "$env")
      }
    }
  }
  return { options, followUps }
}

export function optionsAt(program: File, positions: ReadonlySet<number>): ObjectExpression[] {
  const options: ObjectExpression[] = []
  walk(program, (node) => {
    if (node.type === "ObjectExpression" && positions.has(start(node))) options.push(node)
  })
  return options
}
