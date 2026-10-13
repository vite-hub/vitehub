import * as v from "valibot"
import { createRule, defineDoctorDiagnostics, defineDoctorExtension, defineRulePack } from "vite-doctor/extension"
import type { DoctorExtension, DoctorRule, RuleContext } from "vite-doctor/extension"

import frameworkPackageManifest from "../package.json" with { type: "json" }

const diagnostics = defineDoctorDiagnostics(
  [
    { code: "VHUB0001", ruleId: "vitehub/no-internal-imports" },
    { code: "VHUB0002", ruleId: "vitehub/no-server-imports-in-client" },
    { code: "VHUB0003", ruleId: "vitehub/destructure-storage-results" },
  ],
  { docsBase: code => `https://vitehub.dev/docs/reference/doctor-rules#${code.toLowerCase()}` },
)

const identifierSchema = v.object({ type: v.literal("Identifier"), name: v.string() })
const moduleSourceSchema = v.object({
  type: v.picklist(["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"]),
  source: v.object({ value: v.string() }),
  importKind: v.optional(v.string()),
  exportKind: v.optional(v.string()),
  specifiers: v.optional(v.array(v.object({
    importKind: v.optional(v.string()),
    exportKind: v.optional(v.string()),
  }))),
})
const importDeclarationSchema = v.object({
  type: v.literal("ImportDeclaration"),
  source: v.object({ value: v.string() }),
  specifiers: v.array(v.object({
    type: v.string(),
    imported: v.optional(identifierSchema),
    local: identifierSchema,
  })),
})
const wrapperSchema = v.object({
  type: v.picklist(["ParenthesizedExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression"]),
  expression: v.unknown(),
})
const memberCallSchema = v.object({
  type: v.literal("CallExpression"),
  callee: v.object({
    type: v.literal("MemberExpression"),
    computed: v.literal(false),
    object: v.unknown(),
    property: identifierSchema,
  }),
})
const awaitSchema = v.object({ type: v.literal("AwaitExpression"), argument: v.unknown() })
const arrayPatternSchema = v.object({ type: v.literal("ArrayPattern") })
const resultUseSchema = v.variant("type", [
  v.object({ type: v.literal("VariableDeclarator"), id: v.unknown(), init: v.unknown() }),
  v.object({ type: v.literal("AssignmentExpression"), left: v.unknown(), right: v.unknown() }),
  v.object({ type: v.literal("LogicalExpression"), left: v.unknown(), right: v.unknown() }),
  v.object({ type: v.literal("UnaryExpression"), operator: v.string(), argument: v.unknown() }),
  v.object({ type: v.literal("MemberExpression"), object: v.unknown() }),
  v.object({ type: v.literal("IfStatement"), test: v.unknown() }),
  v.object({ type: v.literal("WhileStatement"), test: v.unknown() }),
  v.object({ type: v.literal("DoWhileStatement"), test: v.unknown() }),
  v.object({ type: v.literal("ConditionalExpression"), test: v.unknown() }),
])
const numericIndexSchema = v.object({
  type: v.literal("MemberExpression"),
  computed: v.literal(true),
  property: v.object({ type: v.literal("Literal"), value: v.number() }),
})

function moduleSpecifier(node: unknown) {
  if (!v.is(moduleSourceSchema, node)) return
  const specifiers = node.specifiers ?? []
  return {
    specifier: node.source.value,
    typeOnly: node.importKind === "type" || node.exportKind === "type"
      || (specifiers.length > 0 && specifiers.every(specifier => specifier.importKind === "type" || specifier.exportKind === "type")),
  }
}

const generatedFile = /(?:^|\/)\.vitehub\//
const generatedImport = /(?:^|\/)\.vitehub(?:\/|$)/
const internalImport = /^(?:vite-hub\/_internal|@vite-hub\/internal|@vite-hub\/[^/]+\/_?internal)(?:\/|$)/

export const noInternalImports: DoctorRule = createRule({
  meta: {
    id: "vitehub/no-internal-imports",
    title: "Import ViteHub through its public paths",
    category: "imports",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    if (generatedFile.test(ctx.file.relativePath)) return
    return {
      ScriptNode(node) {
        const specifier = moduleSpecifier(node)?.specifier
        if (!specifier) return
        if (generatedImport.test(specifier)) {
          ctx.report(diagnostics.diagnostics.VHUB0001({
            why: `\`${specifier}\` imports a file that ViteHub generates. ViteHub can replace or remove generated files on the next build.`,
            fix: "Import the stable `#vitehub/*` alias or the `vite-hub/*` path that the ViteHub import paths reference lists.",
          }), { range: ctx.range(node) })
        }
        else if (internalImport.test(specifier)) {
          ctx.report(diagnostics.diagnostics.VHUB0001({
            why: `\`${specifier}\` is an internal ViteHub path. Only generated ViteHub code and package implementations use it, and it can change in any release.`,
            fix: "Import the public `vite-hub/*` path for this feature. The ViteHub import paths reference lists each one.",
          }), { range: ctx.range(node) })
        }
      },
    }
  },
})

const serverOnlyImports = new Set([
  "#vitehub/env/server",
  "#vitehub/auth/server",
  "@vite-hub/database/drizzle",
  "@vite-hub/env/secret",
  "vite-hub/database/drizzle",
  "vite-hub/env/secret",
])
const serverSubpath = /^(?:vite-hub|@vite-hub\/[^/]+)(?:\/[^/]+)*\/server(?:\/|$)/
const clientAppDirs = ["components", "composables", "layouts", "middleware", "pages", "plugins", "stores", "utils"]

function isClientFile(ctx: RuleContext) {
  const path = ctx.file.relativePath
  if (/(?:^|\/)server\//.test(path) || /\.server\.[^/]+$/.test(path)) return false
  if (path.endsWith(".vue")) return true
  return ctx.project.framework === "nuxt" && clientAppDirs.some(dir => ctx.file.inAppDir(dir))
}

export const noServerImportsInClient: DoctorRule = createRule({
  meta: {
    id: "vitehub/no-server-imports-in-client",
    title: "Keep server-only ViteHub imports out of client code",
    category: "security",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    if (!isClientFile(ctx)) return
    return {
      ScriptNode(node) {
        const source = moduleSpecifier(node)
        if (!source || source.typeOnly || !(serverOnlyImports.has(source.specifier) || serverSubpath.test(source.specifier))) return
        ctx.report(diagnostics.diagnostics.VHUB0002({
          why: `\`${source.specifier}\` is server-only, and \`${ctx.file.relativePath}\` runs in the browser. ViteHub does not block this import, so the client bundle can include server code and Server Env values.`,
          fix: "Move this code to a server route under `server/` and call that route from the client. Use `#vitehub/env/public` for values that the browser can read.",
        }), { range: ctx.range(node) })
      },
    }
  },
})

const storageModules = new Map([
  ["vite-hub/kv", "kv"],
  ["@vite-hub/kv", "kv"],
  ["vite-hub/blob", "blob"],
  ["@vite-hub/blob", "blob"],
])
const storageMethods = new Set([
  "clear", "createMultipartUpload", "del", "get", "getAndDelete", "handleMultipartUpload", "handleUpload", "has",
  "head", "increment", "keys", "list", "put", "resumeMultipartUpload", "serve", "set", "sign",
])

function unwrap(node: unknown): unknown {
  return v.is(wrapperSchema, node) ? unwrap(node.expression) : node
}

// Collect bindings before checking uses, including declarations later in a scope.
const astNodeSchema = v.looseObject({ type: v.string() })
type StorageBinding = { helper?: boolean, init?: unknown }
type StorageScope = { parent?: StorageScope, functionScope: boolean, bindings: Map<string, StorageBinding> }

function namespaceIdentifier(node: unknown): v.InferOutput<typeof identifierSchema> | undefined {
  if (v.is(identifierSchema, node)) return node
  if (v.is(astNodeSchema, node) && node.type === "TSQualifiedName") return namespaceIdentifier(node.left)
}

// Empty/type-only namespaces are erased, including nested namespace bodies.
function instantiatesNamespace(node: unknown): boolean {
  if (!v.is(astNodeSchema, node) || node.declare === true) return false
  switch (node.type) {
    case "TSInterfaceDeclaration":
    case "TSTypeAliasDeclaration":
    case "TSImportEqualsDeclaration":
      return false
    case "TSModuleDeclaration":
      return Boolean(namespaceIdentifier(node.id)) && instantiatesNamespace(node.body)
    case "TSModuleBlock":
      return Array.isArray(node.body) && node.body.some(instantiatesNamespace)
    case "ExportNamedDeclaration":
      // Only exported import aliases instantiate a namespace.
      if (v.is(astNodeSchema, node.declaration) && node.declaration.type === "TSImportEqualsDeclaration") {
        return node.exportKind !== "type" && node.declaration.importKind !== "type"
      }
      return node.exportKind !== "type" && (node.declaration
        ? instantiatesNamespace(node.declaration)
        : Array.isArray(node.specifiers) && node.specifiers.some(specifier => v.is(astNodeSchema, specifier) && specifier.exportKind !== "type"))
    default:
      return true
  }
}

function storageScopes(root: unknown) {
  const scopes = new WeakMap<object, StorageScope>()
  const rootScope: StorageScope = { functionScope: true, bindings: new Map() }

  function bind(pattern: unknown, scope: StorageScope, binding: StorageBinding = {}) {
    if (!v.is(astNodeSchema, pattern)) return
    switch (pattern.type) {
      case "Identifier":
        if (v.is(identifierSchema, pattern)) scope.bindings.set(pattern.name, binding)
        break
      case "RestElement": bind(pattern.argument, scope); break
      case "AssignmentPattern": bind(pattern.left, scope); break
      case "ArrayPattern":
        if (Array.isArray(pattern.elements)) for (const element of pattern.elements) bind(element, scope)
        break
      case "ObjectPattern":
        if (Array.isArray(pattern.properties)) {
          for (const property of pattern.properties) {
            if (v.is(astNodeSchema, property)) bind(property.type === "RestElement" ? property.argument : property.value, scope)
          }
        }
        break
    }
  }

  function walk(node: unknown, enclosing: StorageScope, parent?: v.InferOutput<typeof astNodeSchema>, ambient = false) {
    if (!v.is(astNodeSchema, node)) return
    ambient ||= node.declare === true || (node.type === "TSModuleDeclaration" && !namespaceIdentifier(node.id))
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") bind(node.id, enclosing)
    // Any runtime declaration in a merge binds the name; erased declarations leave it intact.
    if (node.type === "TSModuleDeclaration" && !ambient && instantiatesNamespace(node)) bind(namespaceIdentifier(node.id), enclosing)
    const isFunction = ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)
    const isModule = node.type === "TSModuleDeclaration" || node.type === "TSModuleBlock"
    const createsScope = isFunction || isModule || ["BlockStatement", "CatchClause", "ForStatement", "ForInStatement", "ForOfStatement", "SwitchStatement", "ClassDeclaration", "ClassExpression", "StaticBlock"].includes(node.type)
    // Namespace/module bodies also contain `var` declarations; they must not hoist out.
    const scope = createsScope ? { parent: enclosing, functionScope: isFunction || isModule || node.type === "StaticBlock", bindings: new Map<string, StorageBinding>() } : enclosing
    scopes.set(node, scope)
    if (isFunction) {
      bind(node.id, scope)
      if (Array.isArray(node.params)) for (const param of node.params) bind(param, scope)
    }
    if (node.type === "ClassExpression" || node.type === "ClassDeclaration") bind(node.id, scope)
    if (node.type === "CatchClause") bind(node.param, scope)
    if (v.is(importDeclarationSchema, node)) {
      const name = storageModules.get(node.source.value)
      for (const specifier of node.specifiers) bind(specifier.local, scope, { helper: Boolean(name && specifier.imported?.name === name) })
    }
    if (node.type === "VariableDeclarator") {
      let target = scope
      if (parent?.kind === "var") while (!target.functionScope && target.parent) target = target.parent
      bind(node.id, target, { init: node.init })
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent") continue
      if (Array.isArray(value)) for (const child of value) walk(child, scope, node, ambient)
      else walk(value, scope, node, ambient)
    }
  }
  walk(root, rootScope)
  return scopes
}

export const destructureStorageResults: DoctorRule = createRule({
  meta: {
    id: "vitehub/destructure-storage-results",
    title: "Destructure KV and Blob results",
    category: "correctness",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    const scopes = storageScopes(ctx.file.scriptAst)
    // Nuxt auto-imports `kv` and `blob` into server files when those features are on.
    const autoImports = ctx.project.framework === "nuxt" && ctx.file.relativePath.startsWith("server/")
      ? new Set(storageModules.values())
      : new Set<string>()

    function isStorage(node: unknown, seen = new Set<StorageBinding>()): boolean {
      const target = unwrap(node)
      if (v.is(identifierSchema, target)) {
        let scope = scopes.get(target)
        while (scope) {
          const binding = scope.bindings.get(target.name)
          if (binding) {
            if (binding.helper) return true
            if (seen.has(binding)) return false
            seen.add(binding)
            const init = unwrap(binding.init)
            return v.is(memberCallSchema, init) && init.callee.property.name === "store" && isStorage(init.callee.object, seen)
          }
          scope = scope.parent
        }
        return autoImports.has(target.name)
      }
      return v.is(memberCallSchema, target) && target.callee.property.name === "store" && isStorage(target.callee.object, seen)
    }

    function storageCall(node: unknown) {
      const target = unwrap(node)
      if (!v.is(awaitSchema, target)) return
      const call = unwrap(target.argument)
      if (!v.is(memberCallSchema, call)) return
      const method = call.callee.property.name
      if (!storageMethods.has(method) || !isStorage(call.callee.object)) return
      return { method, node: target }
    }

    function check(value: unknown) {
      const call = storageCall(value)
      if (!call) return
      ctx.report(diagnostics.diagnostics.VHUB0003({
        why: `\`${call.method}()\` returns an \`[error, value]\` tuple and does not throw on provider failures. This code uses the tuple as the value. A tuple is always truthy, and the error is lost.`,
        fix: `Destructure the result and handle the error: \`const [error, value] = await store.${call.method}(...)\`, then \`if (error) throw error\`.`,
      }), { range: ctx.range(call.node) })
    }

    return {
      ScriptNode(node) {
        if (!v.is(resultUseSchema, node)) return
        switch (node.type) {
          case "VariableDeclarator": {
            if (!v.is(arrayPatternSchema, node.id)) check(node.init)
            return
          }
          case "AssignmentExpression":
            if (!v.is(arrayPatternSchema, node.left)) check(node.right)
            return
          case "LogicalExpression":
            check(node.left)
            check(node.right)
            return
          case "UnaryExpression":
            if (node.operator === "!") check(node.argument)
            return
          case "MemberExpression":
            if (!v.is(numericIndexSchema, node)) check(node.object)
            return
          default:
            check(node.test)
        }
      },
    }
  },
})

const vitehubDoctorExtension: DoctorExtension = defineDoctorExtension({
  name: "vite-hub",
  rulePacks: [
    defineRulePack({
      name: "vitehub",
      version: frameworkPackageManifest.version,
      rules: [noInternalImports, noServerImportsInClient, destructureStorageResults],
      diagnostics,
      presets: {
        recommended: [
          "vitehub/no-internal-imports",
          "vitehub/no-server-imports-in-client",
          "vitehub/destructure-storage-results",
        ],
      },
    }),
  ],
})

export default vitehubDoctorExtension
