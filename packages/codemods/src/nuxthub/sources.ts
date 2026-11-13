import { readFile } from "node:fs/promises"
import { join, posix } from "node:path"

import { end, indentAt, isReference, keyName, line, parseProgram, start, walk } from "@vite-hub/internal/ast"
import { parse as parseSfc } from "@vue/compiler-sfc"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { blockBindings } from "../shared/bindings.ts"
import { moduleSource } from "../shared/module-source.ts"
import { relativeSpecifier } from "./database.ts"

import type { CallExpression, File, MemberExpression } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"
import type { FileEdit, FollowUp } from "../types.ts"
import type { HubFeatures } from "./config.ts"
import type { SchemaMove } from "./database.ts"

type Feature = "kv" | "blob"

/** NuxtHub import paths and the ViteHub path that replaces each one. */
const replacedSources: Record<string, string> = {
  "hub:db": "vite-hub/database",
  "@nuxthub/db": "vite-hub/database",
  "hub:kv": "vite-hub/kv",
  "@nuxthub/kv": "vite-hub/kv",
  "hub:blob": "vite-hub/blob",
  "@nuxthub/blob": "vite-hub/blob",
}
const schemaSources = new Set(["hub:db:schema", "@nuxthub/db/schema"])

/** Names that each ViteHub path exports for a NuxtHub import. */
const knownExports: Record<string, ReadonlySet<string>> = {
  "vite-hub/database": new Set(["db", "schema"]),
  "vite-hub/kv": new Set(["kv"]),
  "vite-hub/blob": new Set(["blob", "ensureBlob", "BlobObject", "BlobListResult", "BlobPutOptions"]),
}

/** Methods that return an `[error, value]` tuple in ViteHub. */
const tupleMethods: Record<Feature, ReadonlySet<string>> = {
  kv: new Set(["clear", "del", "get", "getAndDelete", "has", "increment", "keys", "list", "set", "setIfAbsent"]),
  blob: new Set(["createMultipartUpload", "del", "get", "handleMultipartUpload", "handleUpload", "head", "list", "put", "resumeMultipartUpload", "sign"]),
}

const legacyHelpers: Record<string, (features: HubFeatures) => string> = {
  hubBlob: features => `hubBlob() was removed in NuxtHub 0.10. Import blob from "vite-hub/blob" and call its methods; serve() returns a Response, and the other methods return [error, value] tuples.${features.blob ? "" : " Set blob: true under vitehub too."}`,
  hubKV: features => `hubKV() was removed in NuxtHub 0.10. Import kv from "vite-hub/kv" and call its methods; each returns an [error, value] tuple.${features.kv ? "" : " Set kv: true under vitehub too."}`,
  hubDatabase: features => `hubDatabase() was removed in NuxtHub 0.10. Query the Database Definition with db from "vite-hub/database".${features.database ? "" : " Set database: true under vitehub and write server/databases/default/index.ts too."}`,
  hubAI: () => "hubAI() was removed in NuxtHub 0.10, and ViteHub has no AI feature. Call the AI provider SDK directly.",
  hubAutoRAG: () => "hubAutoRAG() was removed in NuxtHub 0.10, and ViteHub has no AutoRAG feature.",
  hubVectorize: () => "hubVectorize() was removed in NuxtHub 0.10, and ViteHub has no Vectorize feature.",
  hubBrowser: () => "hubBrowser() was removed in NuxtHub 0.10. Read https://vitehub.dev/docs/browser for browser work on Cloudflare.",
}

export interface SourceInput {
  cwd: string
  features: HubFeatures
  schema?: SchemaMove
  /** Files that the codemod handles elsewhere, such as nuxt.config and moved schema files. */
  skip: ReadonlySet<string>
}

export interface SourceResult {
  edits: FileEdit[]
  followUps: FollowUp[]
  imports: number
  calls: number
}

interface Block {
  code: string
  offset: number
  lineOffset: number
  jsx: boolean
  typescript: boolean
}

function scriptBlocks(file: string, source: string): Block[] {
  if (!file.endsWith(".vue")) {
    return [{ code: source, offset: 0, lineOffset: 0, jsx: /\.[jt]sx$/.test(file), typescript: !/\.(?:c|m)?jsx?$/.test(file) }]
  }
  const { descriptor } = parseSfc(source, { filename: file })
  return [descriptor.script, descriptor.scriptSetup].flatMap((block) => {
    if (!block || block.src) return []
    const lang = block.lang ?? "js"
    return [{ code: block.content, offset: block.loc.start.offset, lineOffset: block.loc.start.line - 1, jsx: lang === "tsx" || lang === "jsx", typescript: lang === "ts" || lang === "tsx" }]
  })
}

function pickName(base: string, prefixed: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  if (!taken.has(prefixed)) return prefixed
  for (let index = 2; ; index++) if (!taken.has(`${base}${index}`)) return `${base}${index}`
}

/** Why the codemod leaves a call for the user, from how the code uses its result. */
function usageMessage(label: string, call: CallExpression, ancestors: readonly Node[]): string {
  let child: Node = call
  let index = ancestors.length - 1
  if (ancestors[index]?.type === "AwaitExpression") {
    child = ancestors[index]!
    index--
  }
  const parent = ancestors[index]
  if (parent?.type === "ReturnStatement" || (parent?.type === "ArrowFunctionExpression" && parent.body === child)) {
    return `${label} returns its result to the caller. In ViteHub it resolves to an [error, value] tuple instead of throwing. Check the error, then return the value.`
  }
  if ((parent?.type === "MemberExpression" || parent?.type === "OptionalMemberExpression") && parent.object === child) {
    const property = keyName(parent.property, parent.computed)
    if (property === "then") return `${label}.then() now receives an [error, value] tuple instead of the value. Check the error in the tuple.`
    if (property === "catch") return `${label}.catch() no longer runs on failure, because the promise resolves to an [error, value] tuple. Check the error in the tuple instead.`
  }
  if (parent?.type === "ExpressionStatement" && child === call) {
    return `${label} is not awaited. In ViteHub a failure does not reject; it resolves to an [error, value] tuple. Await it and check the error.`
  }
  return `${label} is used inside an expression. In ViteHub it resolves to an [error, value] tuple instead of the value. Check the error, then use the value.`
}

/** True when the innermost function around a node is async. */
function insideAsyncFunction(ancestors: readonly Node[]): boolean {
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const node = ancestors[index]!
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "ObjectMethod" || node.type === "ClassMethod") return node.async
  }
  return false
}

interface CallSite {
  call: CallExpression
  member: MemberExpression
  feature: Feature
  receiver: string
  ancestors: Node[]
}

/** Rewrites the KV and Blob calls of one server module to check the `[error, value]` tuple. */
function rewriteCalls(file: string, code: string, program: File, output: MagicString, receivers: Map<string, Feature>, followUps: FollowUp[]): number {
  const names = new Set<string>()
  walk(program, (node) => {
    if (node.type === "Identifier") names.add(node.name)
  })
  const sites: CallSite[] = []
  walk(program, (node, ancestors) => {
    if (node.type !== "Identifier" || !receivers.has(node.name)) return
    const parent = ancestors.at(-1)
    if (!isReference(node, parent) || parent?.type === "TSTypeQuery") return
    const feature = receivers.get(node.name)!
    if (parent?.type === "MemberExpression" && parent.object === node && ancestors.at(-2)?.type === "CallExpression") {
      const call = ancestors.at(-2)
      if (call?.type === "CallExpression" && call.callee === parent) {
        sites.push({ call, member: parent, feature, receiver: node.name, ancestors: ancestors.slice(0, -2) })
        return
      }
    }
    followUps.push({ file, line: line(node), message: `${node.name} is used here other than in a direct method call. ${feature === "kv" ? "KV methods resolve to [error, value] tuples." : "Blob serve() takes a Request and returns a Response; tuple-returning methods need an error check."} Check the code that calls it.` })
  })
  // In source order, inner calls first, so an outer rewrite copies their edits.
  sites.sort((left, right) => end(left.call) - end(right.call))
  const declared = new Map<Node, Set<string>>()
  let rewritten = 0
  for (const site of sites) {
    const { call, member, feature, receiver, ancestors } = site
    const method = keyName(member.property, member.computed)
    const renamed = feature === "blob" && method === "delete"
    const propertyText = member.computed ? `${code[start(member.property)]}del${code[start(member.property)]}` : "del"
    const name = renamed ? "del" : method
    const label = `${receiver}.${name ?? "[method]"}()`
    if (feature === "blob" && name === "serve") {
      const argument = call.arguments[0]
      const handlerIndex = ancestors.findLastIndex(node => node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression" || node.type === "FunctionDeclaration")
      const handler = ancestors[handlerIndex]
      const wrapper = ancestors[handlerIndex - 1]
      if (argument?.type === "Identifier" && (handler?.type === "ArrowFunctionExpression" || handler?.type === "FunctionExpression")
        && handler.params[0]?.type === "Identifier" && handler.params[0].name === argument.name
        && wrapper?.type === "CallExpression" && wrapper.callee.type === "Identifier" && ["defineEventHandler", "eventHandler"].includes(wrapper.callee.name)) {
        output.overwrite(start(argument), end(argument), `${argument.name}.req`)
        rewritten++
      }
      else {
        followUps.push({ file, line: line(call), message: `${label} returns a Response unchanged, not an [error, value] tuple. Pass a Request as its first argument (event.req for an H3 event) instead of the old event, and return the Response.` })
      }
      continue
    }
    if (!name || !tupleMethods[feature].has(name)) {
      if (renamed) output.overwrite(start(member.property), end(member.property), propertyText)
      followUps.push({ file, line: line(call), message: name === "store"
        ? `${receiver}.store() returns a named store. Its methods resolve to [error, value] tuples too. Check the calls on it.`
        : `ViteHub ${feature === "kv" ? "KV" : "Blob"} has no ${name ?? "computed"} method. Rewrite this call with the ViteHub API. See https://vitehub.dev/docs/${feature}/server-api.` })
      continue
    }
    const callText = renamed
      ? `${output.slice(start(call), start(member.property))}${propertyText}${output.slice(end(member.property), end(call))}`
      : output.slice(start(call), end(call))
    const awaited = ancestors.at(-1)?.type === "AwaitExpression"
    const declarator = awaited ? ancestors.at(-2) : undefined
    const declaration = declarator?.type === "VariableDeclarator" ? ancestors.at(-3) : undefined
    const expression = awaited && ancestors.at(-2)?.type === "ExpressionStatement" ? ancestors.at(-2) : undefined
    // `return blob.del(p)` and `return await kv.get(k)`. The rewrite adds `await`, so only inside an async function.
    const returned = ancestors.at(awaited ? -2 : -1)
    const returnStatement = returned?.type === "ReturnStatement" && insideAsyncFunction(ancestors) ? returned : undefined
    const statement = declaration?.type === "VariableDeclaration" && declaration.declarations.length === 1 ? declaration : expression ?? returnStatement
    const container = statement ? ancestors.at(statement === declaration ? -4 : statement === returnStatement && !awaited ? -2 : -3) : undefined
    if (!statement || (container?.type !== "BlockStatement" && container?.type !== "Program")) {
      if (renamed) output.overwrite(start(member.property), end(member.property), propertyText)
      followUps.push({ file, line: line(call), message: usageMessage(label, call, ancestors) })
      continue
    }
    const taken = new Set([...names, ...(declared.get(container) ?? [])])
    const errorName = pickName("error", `${feature}Error`, taken)
    taken.add(errorName)
    const semicolon = code[end(statement) - 1] === ";" ? ";" : ""
    const indent = indentAt(code, start(statement))
    const check = `${indent}if (${errorName}) throw ${errorName}${semicolon}`
    const lines: string[] = []
    if (statement.type === "ExpressionStatement") {
      lines.push(`const [${errorName}] = await ${callText}${semicolon}`, check)
    }
    else if (statement.type === "ReturnStatement") {
      const valueName = pickName("result", `${feature}Result`, taken)
      taken.add(valueName)
      lines.push(`const [${errorName}, ${valueName}] = await ${callText}${semicolon}`, check, `${indent}return ${valueName}${semicolon}`)
    }
    else if (declarator?.type === "VariableDeclarator" && statement.type === "VariableDeclaration") {
      const id = declarator.id
      if (id.type === "Identifier" && !id.typeAnnotation && statement.kind === "const") {
        lines.push(`const [${errorName}, ${id.name}] = await ${callText}${semicolon}`, check)
      }
      else {
        const valueName = pickName("result", `${feature}Result`, taken)
        taken.add(valueName)
        lines.push(`const [${errorName}, ${valueName}] = await ${callText}${semicolon}`, check, `${indent}${statement.kind} ${code.slice(start(id), end(id))} = ${valueName}${semicolon}`)
      }
    }
    output.overwrite(start(statement), end(statement), lines.join("\n"))
    declared.set(container, taken)
    rewritten++
  }
  return rewritten
}

/** Rewrites NuxtHub imports, KV and Blob calls, and reports what the codemod cannot rewrite. */
export async function rewriteSources(input: SourceInput): Promise<SourceResult> {
  const { cwd, features, schema } = input
  const files = await glob(["**/*.{ts,mts,cts,js,mjs,cjs,tsx,jsx,vue}"], {
    cwd,
    ignore: ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/.wrangler/**", "**/dist/**", "nuxt.config.*"],
  })
  const movedOld = new Map<string, string>()
  for (const [target, old] of schema?.moved ?? []) movedOld.set(old.replace(/\.(?:ts|mts|js|mjs)$/, "").replace(/\/index$/, ""), target.replace(/\.(?:ts|mts|js|mjs)$/, "").replace(/\/index$/, ""))
  if (schema?.oldModule && schema.schemaModule) movedOld.set(schema.oldModule, schema.schemaModule)
  const result: SourceResult = { edits: [], followUps: [], imports: 0, calls: 0 }
  for (const file of files.sort()) {
    if (input.skip.has(file)) continue
    const source = await readFile(join(cwd, file), "utf8")
    if (!/hub:|@nuxthub\/|hub[A-Z]\w*\(|\b(?:kv|blob|db)[.[]|useUpload|useMultipartUpload|db\/schema/.test(source)) continue
    const output = new MagicString(source)
    const followUps: FollowUp[] = []
    const server = file.split("/").includes("server")
    let blocks: Block[]
    try {
      blocks = scriptBlocks(file, source)
    }
    catch {
      blocks = []
    }
    for (const block of blocks) {
      let program: File
      try {
        program = parseProgram(block.code, { typescript: block.typescript, jsx: block.jsx })
      }
      catch {
        if (/hub:|@nuxthub\//.test(block.code)) followUps.push({ file, message: "The codemod could not parse this file. Replace its NuxtHub imports by hand." })
        continue
      }
      const at = (node: Node) => line(node) + block.lineOffset
      const bindings = blockBindings(program)
      const receivers = new Map<string, Feature>()
      const databases = new Set<string>()
      walk(program, (node) => {
        const literal = moduleSource(node)
        if (!literal) return
        const value = literal.value
        let replacement = replacedSources[value]
        if (!replacement && schemaSources.has(value)) {
          if (!schema?.schemaModule) {
            followUps.push({ file, line: at(literal), message: `"${value}" is the NuxtHub schema, and the codemod did not move one. Import the tables from the module that holds them now.` })
            return
          }
          replacement = relativeSpecifier(file, schema.schemaModule)
        }
        if (!replacement) {
          const alias = /^(~~\/|@@\/)/.exec(value)?.[1]
          const path = alias ? value.slice(alias.length) : value.startsWith(".") ? posix.normalize(posix.join(posix.dirname(file), value)) : undefined
          const moved = path ? movedOld.get(path.replace(/\.(?:ts|mts|js|mjs)$/, "").replace(/\/index$/, "")) : undefined
          if (moved) replacement = alias ? `${alias}${moved}` : relativeSpecifier(file, moved)
        }
        if (!replacement) {
          if (/^hub:|^@nuxthub\//.test(value)) followUps.push({ file, line: at(literal), message: `"${value}" has no ViteHub replacement. Rewrite this import by hand.` })
          return
        }
        output.overwrite(block.offset + start(literal) + 1, block.offset + end(literal) - 1, replacement)
        result.imports++
        if (node.type !== "ImportDeclaration") return
        const exported = knownExports[replacement]
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") {
            if (exported) followUps.push({ file, line: at(specifier), message: `Check this ${specifier.type === "ImportDefaultSpecifier" ? "default" : "namespace"} import: ${replacement} has named exports only.` })
            continue
          }
          const imported = keyName(specifier.imported)
          if (exported && imported && !exported.has(imported)) followUps.push({ file, line: at(specifier), message: `Check that ${replacement} exports ${imported}. The codemod changed the path only.` })
          if ((imported === "kv" || imported === "blob") && replacement === `vite-hub/${imported}`) receivers.set(specifier.local.name, imported)
          if (imported === "db" && replacement === "vite-hub/database") databases.add(specifier.local.name)
        }
      })
      const script = !file.endsWith(".vue")
      for (const [name, feature] of receivers) {
        if ((bindings.get(name)?.length ?? 0) > 1) {
          followUps.push({ file, message: `${name} is declared more than once in this file, so the codemod did not rewrite its calls. Check tuple errors by hand.${feature === "blob" ? " serve() takes a Request and returns a Response unchanged." : ""}` })
          receivers.delete(name)
        }
      }
      // NuxtHub auto-imports kv and blob in server code, and ViteHub does too.
      if (server && script) {
        for (const feature of ["kv", "blob"] as const) if (features[feature] && !bindings.has(feature)) receivers.set(feature, feature)
        if (features.database && !bindings.has("db")) databases.add("db")
      }
      if (receivers.size && script) {
        result.calls += rewriteCalls(file, source, program, output, receivers, followUps)
      }
      walk(program, (node) => {
        if (node.type === "MemberExpression" && keyName(node.property, node.computed) === "query" && node.object.type === "Identifier" && databases.has(node.object.name)) {
          followUps.push({ file, line: at(node), message: "Drizzle 1.0 changes relational queries. Replace callback where and orderBy options with Drizzle 1.0 query syntax, migrate declared relations with defineRelations(), and pass them to the Database Definition. Check ownership filters and nested queries before running this call." })
        }
        if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || bindings.has(node.callee.name)) return
        const name = node.callee.name
        const legacy = legacyHelpers[name]
        if (legacy) followUps.push({ file, line: at(node), message: legacy(features) })
        if (name === "useUpload") {
          const options = node.arguments[1]
          const multiple = options?.type === "ObjectExpression" && options.properties.some(property => property.type === "ObjectProperty" && keyName(property.key, property.computed) === "multiple")
          if (!multiple) followUps.push({ file, line: at(node), message: "ViteHub's useUpload() returns an array by default. Set { multiple: false } when this code expects one uploaded object." })
        }
        if (name === "useMultipartUpload") {
          followUps.push({ file, line: at(node), message: "ViteHub's useMultipartUpload() takes concurrency instead of concurrent, and sends another request format. Update this client and its multipart server route together." })
        }
      })
    }
    const after = output.toString()
    if (after !== source) result.edits.push({ path: file, before: source, after })
    result.followUps.push(...followUps)
  }
  return result
}
