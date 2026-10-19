import { readFile } from "node:fs/promises"

import { collectGlobFiles, globFilePath, resolveGlobInput } from "../sources/glob.ts"

import type { GlobInput } from "../sources/glob.ts"

/**
 * Bundling glob(): a ViteHub server build swaps each `glob()` call whose options are literals for a module that holds
 * the files it matches, through files(). Hosts without a file system, such as Cloudflare Workers, then serve the same
 * keys and bytes that glob() reads from disk. `vite dev` keeps glob() as it is.
 */

/** Prefix of the generated modules' ids. `\0` keeps other plugins from resolving or transforming them. */
export const BUNDLED_GLOB_ID = "\0vitehub-source-glob:"
/** Matches those ids, for Rolldown's hook filters. */
export const BUNDLED_GLOB_ID_PATTERN = /^\0vitehub-source-glob:/

/** The ESTree node shape the rewrite reads; Rollup's `this.parse()` returns these. */
interface Node {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

export interface GlobCall {
  start: number
  end: number
  /** The call's options, or undefined when they are not literals and the files stay on disk. */
  input?: GlobInput
  /** Where `files()` comes from, next to the `glob` the app imported (`vite-hub/source/files`, say). */
  filesModule: string
}

const GLOB_MODULE = /^(?:@vite-hub|vite-hub)\/source\/glob$/
const OPTION_KEYS = new Set(["cwd", "dot", "followSymlinks", "ignore", "include", "keyCache", "prefix"])

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as Node).type === "string"
}

function walk(node: Node, visit: (node: Node) => void) {
  visit(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => isNode(child) && walk(child, visit))
    else if (isNode(value)) walk(value, visit)
  }
}

/** A literal's value, or undefined for anything that is not one. */
function literal(node: Node | undefined): unknown {
  if (!node) return undefined
  if (node.type === "Literal") return node.value
  if (node.type === "TemplateLiteral" && (node.expressions as Node[]).length === 0) return ((node.quasis as Node[])[0]!.value as { cooked: string }).cooked
  if (node.type === "ArrayExpression") {
    const items = (node.elements as (Node | null)[]).map(element => (element ? literal(element) : undefined))
    return items.every(item => typeof item === "string") ? items : undefined
  }
  return undefined
}

function globInput(node: Node | undefined): GlobInput | undefined {
  const value = literal(node)
  if (typeof value === "string") return value
  if (node?.type !== "ObjectExpression") return undefined
  const options: Record<string, unknown> = {}
  for (const property of node.properties as Node[]) {
    if (property.type !== "Property" || property.computed || property.kind !== "init") return undefined
    const key = property.key as Node
    const name = key.type === "Identifier" ? key.name : key.value
    if (typeof name !== "string" || !OPTION_KEYS.has(name)) return undefined
    const option = literal(property.value as Node)
    if (option === undefined) return undefined
    options[name] = option
  }
  return typeof options.include === "string" || Array.isArray(options.include) ? options as unknown as GlobInput : undefined
}

/** Every `glob()` call in a module, by the names `glob` was imported under. */
export function findGlobCalls(program: Node): GlobCall[] {
  const imported = new Map<string, string>()
  for (const statement of program.body as Node[]) {
    if (statement.type !== "ImportDeclaration") continue
    const source = (statement.source as Node).value
    if (typeof source !== "string" || !GLOB_MODULE.test(source)) continue
    for (const specifier of statement.specifiers as Node[]) {
      const name = (specifier.imported as Node | undefined)?.name ?? (specifier.imported as Node | undefined)?.value
      if (specifier.type === "ImportSpecifier" && name === "glob") imported.set((specifier.local as Node).name as string, source.replace(/\/glob$/, "/files"))
    }
  }
  if (imported.size === 0) return []
  const calls: GlobCall[] = []
  walk(program, (node) => {
    if (node.type !== "CallExpression") return
    const callee = node.callee as Node
    const filesModule = callee.type === "Identifier" ? imported.get(callee.name as string) : undefined
    if (!filesModule) return
    const args = node.arguments as Node[]
    calls.push({ start: node.start, end: node.end, input: args.length === 1 ? globInput(args[0]) : undefined, filesModule })
  })
  return calls
}

/** The id of the module that holds what one call matches. */
export function bundledGlobId(call: GlobCall & { input: GlobInput }): string {
  return BUNDLED_GLOB_ID + encodeURIComponent(JSON.stringify({ filesModule: call.filesModule, input: call.input }))
}

/** The module with each call whose options are literals swapped for its bundled files. */
export function rewriteGlobCalls(code: string, calls: GlobCall[]): string {
  let output = code
  const imports: string[] = []
  const bundled = calls.filter((call): call is GlobCall & { input: GlobInput } => call.input !== undefined)
  bundled.forEach((call, index) => imports.push(`import __vitehubGlob${index} from ${JSON.stringify(bundledGlobId(call))};`))
  // From the end, so earlier offsets stay right.
  for (const [index, call] of [...bundled.entries()].reverse()) {
    output = output.slice(0, call.start) + `__vitehubGlob${index}` + output.slice(call.end)
  }
  return imports.length ? `${imports.join("\n")}\n${output}` : output
}

/** The files a call matches, read as glob() reads them, and the paths to watch. */
export async function collectBundledGlob(input: GlobInput, rootDir: string) {
  const options = resolveGlobInput(input)
  const { paths, keys } = await collectGlobFiles(rootDir, options)
  const entries: Record<string, Uint8Array> = {}
  const watched: string[] = []
  for (const key of keys) {
    const path = await globFilePath(key, paths, options.followSymlinks === true)
    if (!path) continue
    entries[key] = new Uint8Array(await readFile(path))
    watched.push(path)
  }
  return { entries, prefix: options.prefix, watched }
}

const utf8 = new TextDecoder("utf-8", { fatal: true })

/** One file in the generated module: text stays readable, anything else is base64. Both load as bytes, as glob() reads them. */
function fileExpression(bytes: Uint8Array) {
  try {
    const text = utf8.decode(bytes)
    if (!text.includes("\0")) return `text(${JSON.stringify(text)})`
  }
  catch {}
  return `bytes(${JSON.stringify(Buffer.from(bytes).toString("base64"))})`
}

/** The generated module: the matched files, served through files(). */
export function renderBundledGlob(filesModule: string, entries: Record<string, Uint8Array>, prefix?: string): string {
  const lines = Object.entries(entries).map(([key, bytes]) => `  ${JSON.stringify(key)}: ${fileExpression(bytes)},`)
  return [
    `import { files } from ${JSON.stringify(filesModule)}`,
    `const encoder = new TextEncoder()`,
    `const text = value => encoder.encode(value)`,
    `const bytes = value => Uint8Array.from(atob(value), character => character.charCodeAt(0))`,
    `export default files({`,
    ...lines,
    `}${prefix ? `, { prefix: ${JSON.stringify(prefix)} }` : ""})`,
    ``,
  ].join("\n")
}

/** Loads a generated module by its id. */
export async function loadBundledGlob(id: string, rootDir: string): Promise<{ code: string, watched: string[] }> {
  const { filesModule, input } = JSON.parse(decodeURIComponent(id.slice(BUNDLED_GLOB_ID.length))) as { filesModule: string, input: GlobInput }
  const { entries, prefix, watched } = await collectBundledGlob(input, rootDir)
  return { code: renderBundledGlob(filesModule, entries, prefix), watched }
}
