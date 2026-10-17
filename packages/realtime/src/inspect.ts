import { readFileSync } from "node:fs"

import { relativeDefinitionFile } from "@vite-hub/internal/inspect"
import type { ViteHubDefinitionField, ViteHubDefinitionSummary } from "@vite-hub/internal/inspect"
import type { ESTree, parseSync } from "vite"
import type { DiscoveredRealtimeDefinition } from "./types.ts"

export type RealtimeInspectionAuthority = "auto" | "cloudflare" | "memory" | "unsupported"

const authorityLabels: Record<RealtimeInspectionAuthority, string> = {
  auto: "auto: Cloudflare Durable Objects on Cloudflare, memory in development, build error elsewhere",
  cloudflare: "cloudflare: one Durable Object per document, Yjs state in SQLite",
  memory: "memory: one Node process, rooms lost on restart",
  unsupported: "none: this host has no Realtime room authority",
}

function propertyName(property: ESTree.ObjectProperty | ESTree.SpreadElement | ESTree.Node): string | undefined {
  if (property.type !== "Property") return
  const key = property.key
  if (key.type === "Identifier") return key.name
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Literal AST keys can be strings, numbers, or other primitives.
  if (key.type === "Literal" && typeof key.value === "string") return key.value
}

function findDefinitionObject(program: ESTree.Program): ESTree.ObjectExpression | undefined {
  for (const statement of program.body) {
    if (statement.type !== "ExportDefaultDeclaration") continue
    let node: ESTree.Node = statement.declaration
    if (node.type === "CallExpression" && node.arguments[0]?.type === "ObjectExpression") node = node.arguments[0]
    if (node.type === "ObjectExpression") return node
  }
}

function properties(object: ESTree.ObjectExpression): Map<string, ESTree.Node> {
  const values = new Map<string, ESTree.Node>()
  for (const property of object.properties) {
    const name = propertyName(property)
    if (name && property.type === "Property") values.set(name, property.value)
  }
  return values
}

function literal(node: ESTree.Node | undefined): unknown {
  return node?.type === "Literal" ? node.value : undefined
}

function calleeName(node: ESTree.Node): string | undefined {
  if (node.type !== "CallExpression") return
  if (node.callee.type === "Identifier") return node.callee.name
  if (node.callee.type === "MemberExpression" && node.callee.property.type === "Identifier") return node.callee.property.name
}

function describeDocument(node: ESTree.Node | undefined): string {
  if (!node) return "missing"
  if (node.type === "ObjectExpression") {
    const values = properties(node)
    const workspace = literal(values.get("workspace"))
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Only a string literal names a Workspace statically.
    if (typeof workspace === "string") return `Workspace ${JSON.stringify(workspace)} (Markdown file per path)`
    if (values.has("load") && values.has("save")) return "custom adapter (inline load/save)"
  }
  const callee = calleeName(node)
  if (callee === "workspaceDocument") {
    const argument = node.type === "CallExpression" ? node.arguments[0] : undefined
    const name = argument && argument.type !== "SpreadElement" ? literal(argument) : undefined
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Only a string literal names a Workspace statically.
    return typeof name === "string" ? `Workspace ${JSON.stringify(name)} (Markdown file per path)` : "Workspace (dynamic name)"
  }
  if (callee) return `custom adapter (${callee}())`
  if (node.type === "Identifier") return `custom adapter (${node.name})`
  return "custom adapter"
}

function describePersistence(node: ESTree.Node | undefined): string {
  if (literal(node) === false) return "explicit saves only"
  let debounce = String(2_000)
  let maxWait = String(10_000)
  if (node?.type === "ObjectExpression") {
    const values = properties(node)
    if (values.has("debounce")) debounce = String(literal(values.get("debounce")) ?? "dynamic")
    if (values.has("maxWait")) maxWait = String(literal(values.get("maxWait")) ?? "dynamic")
  }
  else if (node) return "dynamic"
  return `idle save after ${debounce} ms (at most ${maxWait} ms) and when the last client leaves`
}

/** Reads the static shape of one Realtime Definition file without executing it. */
export function describeRealtimeDefinitionSource(parse: typeof parseSync, file: string, source: string): ViteHubDefinitionField[] {
  let object: ESTree.ObjectExpression | undefined
  let builder: string | undefined
  try {
    const program = parse(file, source).program
    object = findDefinitionObject(program)
    const exported = program.body.find(statement => statement.type === "ExportDefaultDeclaration")
    builder = exported?.type === "ExportDefaultDeclaration" ? calleeName(exported.declaration) : undefined
  }
  catch {}
  if (!object) {
    return [{ label: "Document", value: builder && builder !== "defineRealtime" ? `built by ${builder}() (not statically inspectable)` : "dynamic definition (not statically inspectable)" }]
  }
  const values = properties(object)
  const editor = values.get("editor")
  const auth = literal(values.get("auth")) === true
  const perDocument = editor?.type === "ArrowFunctionExpression" || editor?.type === "FunctionExpression"
  return [
    { label: "Document", value: describeDocument(values.get("document")) },
    { label: "Editor", value: editor ? perDocument ? "custom codec per document" : `custom codec${editor.type === "Identifier" ? ` (${editor.name})` : ""}` : "built-in Markdown kit" },
    {
      label: "Identity",
      value: values.has("identify")
        ? `identify()${auth ? ", required" : ""}`
        : auth ? "ViteHub Auth session, required" : "anonymous; presence names are client-asserted",
    },
    { label: "Authorization", value: values.has("authorize") ? "authorize() per document and mode" : "every connection may read and write" },
    { label: "Persistence", value: describePersistence(values.get("persistence")) },
    { label: "History", value: values.has("history") ? "history.checkpoint() enabled" : "none" },
  ]
}

export async function summarizeRealtimeDefinitions(
  projectRoot: string,
  definitions: readonly DiscoveredRealtimeDefinition[],
  authority: RealtimeInspectionAuthority,
): Promise<ViteHubDefinitionSummary[]> {
  // Vite is an optional peer: load its parser only when inspection runs inside a Vite project.
  const { parseSync } = await import("vite")
  return definitions.map((definition) => {
    let source = ""
    try {
      source = readFileSync(definition.handler, "utf8")
    }
    catch {}
    return {
      fields: [
        ...describeRealtimeDefinitionSource(parseSync, definition.handler, source),
        { label: "Authority", value: authorityLabels[authority] },
      ],
      file: relativeDefinitionFile(projectRoot, definition.handler),
      name: definition.name,
      source: definition.source,
    }
  })
}
