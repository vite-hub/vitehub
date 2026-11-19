import { detectStyle, end, findProperty, indentAt, isReference, keyName, line, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import MagicString from "magic-string"

import { literalValue, staticOptionsObject, unwrapExpression } from "../shared/nuxt-config.ts"

import type { CallExpression, File, ObjectExpression } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"
import type { FollowUp } from "../types.ts"

export const moduleConfigSource = "@nuxtjs/better-auth/config"

/** The result of moving one auth config file. `code` is `undefined` when the file needs no successor. */
export interface DefinitionMove {
  code?: string
  followUps: FollowUp[]
  /** False when the file stays as it is. */
  moved: boolean
}

function parse(file: string, code: string): File | undefined {
  try {
    return parseProgram(code, { typescript: !/\.[cm]?js$/.test(file) })
  }
  catch {
    return undefined
  }
}

/** The default export call of `name`, such as `export default defineServerAuth(...)`. */
function exportedCall(program: File, name: string): CallExpression | undefined {
  const exported = program.program.body.find(statement => statement.type === "ExportDefaultDeclaration")
  const call = exported?.type === "ExportDefaultDeclaration" ? unwrapExpression(exported.declaration) : undefined
  return call?.type === "CallExpression" && call.callee.type === "Identifier" && call.callee.name === name ? call : undefined
}

/** Adds `imports` after the last import, or at the top of the file. */
function addImports(program: File, output: MagicString, imports: readonly string[]): void {
  if (!imports.length) return
  const lastImport = program.program.body.filter(statement => statement.type === "ImportDeclaration").at(-1)
  if (lastImport) output.appendLeft(end(lastImport), `\n${imports.join("\n")}`)
  else output.prepend(`${imports.join("\n")}\n\n`)
}

/**
 * Replaces the module's import of `name` with `importText`. Returns false when the module auto-imported `name`, so the
 * caller adds `importText`.
 */
function swapImport(program: File, output: MagicString, name: string, importText: string, followUp: (node: Node, message: string) => void): boolean {
  let replaced = false
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== moduleConfigSource) continue
    const others = statement.specifiers.filter(specifier => !(specifier.type === "ImportSpecifier" && keyName(specifier.imported) === name))
    if (others.length) {
      followUp(statement, `${moduleConfigSource} also exports ${others.map(specifier => specifier.local.name).join(", ")} here. ViteHub has no such export. Use the Better Auth types, such as BetterAuthOptions from better-auth.`)
      continue
    }
    if (replaced) output.remove(start(statement), end(statement) + (output.original[end(statement)] === "\n" ? 1 : 0))
    else output.overwrite(start(statement), end(statement), importText)
    replaced = true
  }
  return replaced
}

/** The options object of a define call: the argument, or the object a callback returns. */
function optionsObject(argument: Node): ObjectExpression | undefined {
  const value = unwrapExpression(argument)
  if (value.type === "ObjectExpression") return value
  if (value.type !== "ArrowFunctionExpression") return undefined
  if (value.body.type !== "BlockStatement") {
    const body = unwrapExpression(value.body)
    return body.type === "ObjectExpression" ? body : undefined
  }
  const last = value.body.body.at(-1)
  if (last?.type !== "ReturnStatement" || !last.argument) return undefined
  let extraReturn = false
  walk(value.body, (node, ancestors) => {
    if (node.type === "ReturnStatement" && node !== last && !ancestors.some(parent => parent.type === "ArrowFunctionExpression" || parent.type === "FunctionExpression" || parent.type === "FunctionDeclaration" || parent.type === "ObjectMethod" || parent.type === "ClassMethod")) extraReturn = true
  })
  if (extraReturn) return undefined
  const returned = unwrapExpression(last.argument)
  return returned?.type === "ObjectExpression" ? returned : undefined
}

/** Inserts `entries` at the start of `object`. */
function prependProperties(code: string, output: MagicString, object: ObjectExpression, entries: string[], extraIndent: string): void {
  const first = object.properties[0]
  const multiline = first ? code.slice(start(object), start(first)).includes("\n") : false
  if (!first) {
    output.appendLeft(start(object) + 1, ` ${entries.join(", ")} `)
    return
  }
  if (multiline) {
    const indent = `${extraIndent}${indentAt(code, start(first))}`
    output.prependLeft(start(first), entries.map(entry => `${entry.replaceAll("\n", `\n${indent}`)},\n${indent}`).join(""))
    return
  }
  output.prependLeft(start(first), `${entries.join(", ")}, `)
}

export interface ServerDefinitionInput {
  file: string
  code: string
  /** The app has a ViteHub Database, so Auth keeps users there. */
  database: boolean
  /** `access.routes` entries from route rules on server paths. */
  accessRoutes: string[]
  publicRoutes: string[]
  signIn?: string
  afterSignIn?: string
}

/**
 * Moves `server/auth.config.ts` (`defineServerAuth()`) to a ViteHub Auth Definition (`defineAuth()`). The Better Auth
 * options stay as they are. The callback context keeps `requestOrigin`, and `runtimeConfig` becomes
 * `useRuntimeConfig()` from `nitro/runtime-config`.
 */
export function moveServerDefinition(input: ServerDefinitionInput): DefinitionMove {
  const { file, code } = input
  const followUps: FollowUp[] = []
  const follow = (node: Node | undefined, message: string) => followUps.push({ file, ...(node ? { line: line(node) } : {}), message })
  const program = parse(file, code)
  if (!program) {
    follow(undefined, "The codemod could not parse this file. Move it to server/auth.ts with defineAuth() from vite-hub/auth by hand.")
    return { followUps, moved: false }
  }
  const call = exportedCall(program, "defineServerAuth")
  const [argument] = call?.arguments ?? []
  if (!call || !argument || argument.type === "SpreadElement" || argument.type === "ArgumentPlaceholder") {
    follow(call, "This file does not export defineServerAuth(options) by default. Move it to server/auth.ts with defineAuth() from vite-hub/auth by hand.")
    return { followUps, moved: false }
  }
  const callback = unwrapExpression(argument)
  if (callback.type === "FunctionExpression") {
    follow(callback, "Use an arrow function for the Auth Definition callback before migrating.")
    return { followUps, moved: false }
  }
  const returned = optionsObject(argument)
  const options = returned && staticOptionsObject(returned)
  const database = options && findProperty(options, "database")
  if (!options || options.properties.some(property => property.type === "ObjectProperty" && property.computed) || (callback.type === "ObjectExpression" && ((database && literalValue(database.value) !== "memory") || findProperty(options, "secondaryStorage")))) {
    follow(call, "Use explicit Auth options without spreads or computed keys and return custom storage adapters from a callback.")
    return { followUps, moved: false }
  }
  if ((input.accessRoutes.length || input.signIn || input.afterSignIn) && findProperty(options, "access")) {
    follow(call, "Merge the Auth redirects or API route rules with the existing access option by hand.")
    return { followUps, moved: false }
  }
  const basePath = findProperty(options, "basePath")
  if (input.accessRoutes.length && basePath && literalValue(basePath.value) !== "/api/auth") {
    follow(basePath, "Migrate the API route rules by hand to preserve access with a custom Auth basePath.")
    return { followUps, moved: false }
  }
  const style = detectStyle(code, program)
  const semicolon = style.semicolons ? ";" : ""
  const output = new MagicString(code)
  output.overwrite(start(call.callee), end(call.callee), "defineAuth")
  const defineImport = `import { defineAuth } from ${quoteString("vite-hub/auth", style)}${semicolon}`
  const imports = swapImport(program, output, "defineServerAuth", defineImport, follow) ? [] : [defineImport]

  let needsRuntimeConfig = false
  // Set when an expression body becomes a block, which indents it one level.
  let extraIndent = ""
  if (callback.type === "ArrowFunctionExpression") {
    const [context] = callback.params
    if (context?.type === "ObjectPattern") {
      const kept: string[] = []
      for (const property of context.properties) {
        const key = property.type === "ObjectProperty" ? keyName(property.key, property.computed) : undefined
        if (key === "runtimeConfig" && property.type === "ObjectProperty" && property.value.type === "Identifier") {
          needsRuntimeConfig = true
          const local = property.value.name
          const body = callback.body
          const declaration = `const ${local} = useRuntimeConfig()${semicolon}`
          if (body.type === "BlockStatement") {
            const first = body.body[0]
            if (first) output.prependLeft(start(first), `${declaration}\n${indentAt(code, start(first))}`)
            else output.appendLeft(start(body) + 1, `\n${style.indent}${declaration}\n`)
          }
          else {
            // `=> ({ ... })`: Babel keeps the parentheses out of the node range.
            const from = body.extra?.parenthesized && typeof body.extra.parenStart === "number" ? body.extra.parenStart : start(body)
            const to = from === start(body) ? end(body) : code.indexOf(")", end(body)) + 1
            const indent = `${indentAt(code, start(call))}${style.indent}`
            output.prependLeft(from, `{\n${indent}${declaration}\n${indent}return `)
            output.appendRight(to, `\n${indentAt(code, start(call))}}`)
            extraIndent = style.indent
            for (let index = code.indexOf("\n", from); index !== -1 && index < to; index = code.indexOf("\n", index + 1)) {
              if (code[index + 1] !== "\n") output.prependRight(index + 1, style.indent)
            }
          }
        }
        else if (key === "requestOrigin") kept.push(code.slice(start(property), end(property)))
        else follow(property, `The ViteHub Auth callback receives { env, request, requestOrigin }. ${key ? `"${key}"` : "This property"} is not in it.${key === "db" ? " Auth reads the app Database with database: authDatabase() from vite-hub/auth/database." : ""}`)
      }
      output.overwrite(start(context), end(context), kept.length ? `{ ${kept.join(", ")} }` : "")
    }
    else if (context?.type === "Identifier") {
      const name = context.name
      walk(callback.body, (node, ancestors) => {
        if (!isReference(node, ancestors.at(-1)) || node.name !== name) return
        const parent = ancestors.at(-1)
        const property = parent?.type === "MemberExpression" && parent.object === node && !parent.computed && parent.property.type === "Identifier" ? parent.property.name : undefined
        if (property === "runtimeConfig" && parent) {
          needsRuntimeConfig = true
          output.overwrite(start(parent), end(parent), "useRuntimeConfig()")
        }
        else if (property !== "requestOrigin") follow(node, `The ViteHub Auth callback receives { env, request, requestOrigin }. ${property ? `${name}.${property}` : name} is not in it.${property === "db" ? " Auth reads the app Database with database: authDatabase() from vite-hub/auth/database." : ""}`)
      })
    }
  }
  if (followUps.length) return { followUps, moved: false }
  if (needsRuntimeConfig) imports.push(`import { useRuntimeConfig } from ${quoteString("nitro/runtime-config", style)}${semicolon}`)

  const entries: string[] = []
  if (input.database) {
    if (!database) {
      entries.push("database: authDatabase()")
      imports.push(`import { authDatabase } from ${quoteString("vite-hub/auth/database", style)}${semicolon}`)
    }
  }
  else if (!database) {
    follow(call, "This config sets no database. ViteHub Auth then keeps users in memory in development, and a production build fails with AUTH_C0063. Set database: authDatabase() from vite-hub/auth/database, or preset: stateless() from vite-hub/auth/presets for social sign-in without a database.")
  }
  const access: string[] = []
  const paths = (routes: string[]) => routes.map(route => quoteString(route, style)).join(", ")
  if (input.accessRoutes.length) access.push(`routes: [${paths(input.accessRoutes)}]`)
  if (input.publicRoutes.length) access.push(`public: [${paths(input.publicRoutes)}]`)
  if (input.signIn) access.push(`signIn: ${quoteString(input.signIn, style)}`)
  if (input.afterSignIn) access.push(`afterSignIn: ${quoteString(input.afterSignIn, style)}`)
  if (access.length) entries.push(`access: { ${access.join(", ")} }`)
  if (entries.length) prependProperties(code, output, options, entries, extraIndent)
  for (const name of ["secret", "baseURL", "basePath"]) {
    const property = options && findProperty(options, name)
    if (property) follow(property, `ViteHub Auth sets ${name} itself${name === "secret" ? " from VITEHUB_SECRET or BETTER_AUTH_SECRET" : ""}. Remove it unless you need another value.`)
  }
  addImports(program, output, imports)
  return { code: output.toString(), followUps, moved: true }
}

/** Moves `app/auth.config.ts` (`defineClientAuth()`) to `app/auth.client.ts` (`defineAuthClient()`). */
export function moveClientDefinition(file: string, code: string): DefinitionMove {
  const followUps: FollowUp[] = []
  const follow = (node: Node | undefined, message: string) => followUps.push({ file, ...(node ? { line: line(node) } : {}), message })
  const program = parse(file, code)
  if (!program) {
    follow(undefined, "The codemod could not parse this file. Move the client plugins to app/auth.client.ts with defineAuthClient() from vite-hub/auth/vue by hand.")
    return { followUps, moved: false }
  }
  const call = exportedCall(program, "defineClientAuth")
  const [argument] = call?.arguments ?? []
  const options = argument && argument.type !== "SpreadElement" && argument.type !== "ArgumentPlaceholder" ? unwrapExpression(argument) : undefined
  if (!call || options?.type !== "ObjectExpression") {
    follow(call, "defineAuthClient() takes an options object. Move this config to app/auth.client.ts with defineAuthClient() from vite-hub/auth/vue by hand.")
    return { followUps, moved: false }
  }
  // Without options, the default client needs no file.
  if (!options.properties.length) return { followUps, moved: true }
  const baseURL = findProperty(options, "baseURL")
  if (baseURL) follow(baseURL, "ViteHub sets the client basePath from the Auth Definition. A client for another server needs its own createAuthClient() from vite-hub/auth/vue.")
  const style = detectStyle(code, program)
  const output = new MagicString(code)
  output.overwrite(start(call.callee), end(call.callee), "defineAuthClient")
  const clientImport = `import { defineAuthClient } from ${quoteString("vite-hub/auth/vue", style)}${style.semicolons ? ";" : ""}`
  if (!swapImport(program, output, "defineClientAuth", clientImport, follow)) addImports(program, output, [clientImport])
  return { code: output.toString(), followUps, moved: true }
}
