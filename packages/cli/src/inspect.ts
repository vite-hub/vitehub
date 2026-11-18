import { existsSync, readFileSync, statSync } from "node:fs"

import { collectViteHubDefinitionInspectors, collectViteHubProviderOutputEntries, collectViteHubResourceSummaries, redactInspectionValue } from "@vite-hub/internal/inspect"
import { PROVISION_STATE_FILE, readProvisionStateSync } from "@vite-hub/internal/provision-state"
import { basename, dirname, relative, resolve } from "pathe"

import type { ViteHubCliCommandNamespace, ViteHubCliContext } from "@vite-hub/internal/cli"
import type { ViteHubDefinitionSummary, ViteHubProviderOutputEntry, ViteHubResourceSummary } from "@vite-hub/internal/inspect"
import type { AnyOperation } from "@vite-hub/internal/operations"

type InspectContext = Pick<ViteHubCliContext, "rootDir" | "stderr" | "stdout">

interface ParsedInspectArgs {
  error?: string
  help: boolean
  json: boolean
  kind?: string
}

const definitionsUsage = "vitehub inspect definitions [--kind <kind>] [--json]"
const providerOutputUsage = "vitehub inspect output [--json]"
const resourcesUsage = "vitehub inspect resources [--json]"
const routesUsage = "vitehub inspect routes [--json]"

function parseArgs(args: string[], options: { kind: boolean }): ParsedInspectArgs {
  const parsed: ParsedInspectArgs = { help: false, json: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "-h" || arg === "--help") parsed.help = true
    else if (arg === "--json") parsed.json = true
    else if (options.kind && arg === "--kind") {
      const kind = args[index + 1]
      if (!kind || kind.startsWith("-")) parsed.error ??= "Option --kind requires a value."
      else {
        parsed.kind = kind
        index++
      }
    }
    else if (options.kind && arg?.startsWith("--kind=")) {
      const kind = arg.slice("--kind=".length)
      if (!kind) parsed.error ??= "Option --kind requires a value."
      else parsed.kind = kind
    }
    else if (arg) parsed.error ??= `Unknown inspect argument: ${arg}`
  }
  return parsed
}

function writeJson(context: InspectContext, value: unknown): void {
  context.stdout.write(`${JSON.stringify(redactInspectionValue(value), null, 2)}\n`)
}

function redactSummary(summary: ViteHubDefinitionSummary): ViteHubDefinitionSummary {
  return {
    ...summary,
    fields: summary.fields.map(field => ({ label: field.label, value: String(redactInspectionValue(field.value, field.label)) })),
  }
}

/** The operations of the app as one Definition kind. */
function operationInspector(operations: readonly AnyOperation[]) {
  return {
    kind: "operation",
    label: "Operations",
    list: (): ViteHubDefinitionSummary[] => operations.map(operation => ({
      fields: [
        { label: "Kind", value: operation.kind },
        { label: "Section", value: typeof operation.section === "string" ? operation.section : operation.section === false ? "any" : "from input" },
        { label: "Description", value: operation.description },
        { label: "Command", value: `vitehub ${operation.cli?.namespace ?? (typeof operation.section === "string" ? operation.section : operation.name.slice(0, operation.name.indexOf(".")))} ${operation.cli?.command ?? operation.name.slice(operation.name.indexOf(".") + 1)}` },
      ],
      file: "operations",
      name: operation.name,
      source: "operations",
    })),
  }
}

async function runDefinitions(args: string[], context: InspectContext, plugins: readonly unknown[], operations: readonly AnyOperation[]): Promise<number> {
  const parsed = parseArgs(args, { kind: true })
  if (parsed.help) {
    context.stdout.write([
      `Usage: ${definitionsUsage}`,
      "",
      "Lists the Definitions that each active package discovered.",
      "",
      "Options:",
      "  --kind <kind>  Show one kind only, for example queue or rate-limit.",
      "  --json         Print machine-readable JSON.",
      "  -h, --help     Show this help.",
      "",
    ].join("\n"))
    return 0
  }
  if (parsed.error) {
    context.stderr.write(`${parsed.error}\nUsage: ${definitionsUsage}\n`)
    return 1
  }

  const inspectors = [...await collectViteHubDefinitionInspectors(plugins), ...(operations.length ? [operationInspector(operations)] : [])]
  const selected = parsed.kind ? inspectors.filter(inspector => inspector.kind === parsed.kind) : inspectors
  if (parsed.kind && !selected.length) {
    const kinds = inspectors.map(inspector => inspector.kind).sort()
    context.stderr.write(`Unknown Definition kind: ${parsed.kind}\nAvailable kinds: ${kinds.length ? kinds.join(", ") : "none"}\n`)
    return 1
  }

  const groups = await Promise.all(selected.map(async inspector => ({
    definitions: (await inspector.list()).map(redactSummary),
    kind: inspector.kind,
    label: inspector.label,
  })))

  if (parsed.json) {
    writeJson(context, { definitions: groups })
    return 0
  }

  if (!groups.length) {
    context.stdout.write("No package contributes Definition inspection.\n")
    return 0
  }
  const lines: string[] = []
  for (const group of groups) {
    lines.push(`${group.label} (${group.kind}): ${group.definitions.length}`)
    if (!group.definitions.length) lines.push("  No Definitions discovered.")
    for (const definition of group.definitions) {
      lines.push(`  ${definition.name}  ${definition.file}  [${definition.source}]`)
      for (const field of definition.fields) lines.push(`    ${field.label}: ${field.value}`)
    }
    lines.push("")
  }
  context.stdout.write(lines.join("\n"))
  return 0
}

interface ProviderOutputReport {
  content?: unknown
  description: string
  exists: boolean
  owner: string
  path: string
  type?: "directory" | "file"
}

function readProviderOutputEntry(rootDir: string, entry: ViteHubProviderOutputEntry): ProviderOutputReport {
  const path = relative(rootDir, entry.path) || "."
  if (!existsSync(entry.path)) return { description: entry.description, exists: false, owner: entry.owner, path }
  const directory = statSync(entry.path).isDirectory()
  const report: ProviderOutputReport = {
    description: entry.description,
    exists: true,
    owner: entry.owner,
    path,
    type: directory ? "directory" : "file",
  }
  if (!directory && entry.path.endsWith(".json")) {
    try {
      report.content = JSON.parse(readFileSync(entry.path, "utf8"))
    }
    catch {
      report.content = "[unreadable JSON]"
    }
  }
  return report
}

async function runProviderOutput(args: string[], context: InspectContext, plugins: readonly unknown[]): Promise<number> {
  const parsed = parseArgs(args, { kind: false })
  if (parsed.help) {
    context.stdout.write([
      `Usage: ${providerOutputUsage}`,
      "",
      "Lists generated Provider Output files and shows which exist.",
      "Run a production build first to generate deployment output.",
      "JSON output includes file contents with credentials and Worker vars redacted.",
      "",
      "Options:",
      "  --json      Print machine-readable JSON.",
      "  -h, --help  Show this help.",
      "",
    ].join("\n"))
    return 0
  }
  if (parsed.error) {
    context.stderr.write(`${parsed.error}\nUsage: ${providerOutputUsage}\n`)
    return 1
  }

  const entries = [
    ...await collectViteHubProviderOutputEntries(plugins),
    { description: "Provision State with non-secret provider resource ids", owner: "cli", path: resolve(context.rootDir, PROVISION_STATE_FILE) },
  ]
  const reports = entries
    .map(entry => readProviderOutputEntry(context.rootDir, entry))
    .sort((left, right) => left.path.localeCompare(right.path))

  if (parsed.json) {
    const provisionPath = relative(context.rootDir, resolve(context.rootDir, PROVISION_STATE_FILE)) || "."
    const providerOutput = reports.map(report => {
      if (report.path === provisionPath && report.exists && report.owner === "cli" && report.type === "file" && report.content !== "[unreadable JSON]") {
        const provisionState = readProvisionStateSync(context.rootDir)
        const provisionStateOutput = Object.fromEntries(Object.entries(provisionState).map(([provider, categories]) => [
          provider,
          Object.fromEntries(Object.entries(categories ?? {}).map(([category, ids]) => [
            category,
            Object.fromEntries(Object.entries(ids ?? {}).map(([key, id]) => [key, redactInspectionValue(id)])),
          ])),
        ]))
        return { ...report, content: provisionStateOutput }
      }
      return redactInspectionValue(report)
    })
    context.stdout.write(`${JSON.stringify({ providerOutput }, null, 2)}\n`)
    return 0
  }

  const present = reports.filter(report => report.exists)
  const missing = reports.filter(report => !report.exists)
  const lines = [`Provider Output: ${present.length} of ${reports.length} present`]
  for (const report of present) lines.push(`  ${report.path}  (${report.owner}) ${report.description}`)
  if (missing.length) {
    lines.push("", "Not generated:")
    for (const report of missing) lines.push(`  ${report.path}  (${report.owner}) ${report.description}`)
  }
  lines.push("")
  context.stdout.write(lines.join("\n"))
  return 0
}

const wranglerIdFields = { "cloudflare-d1": ["d1_databases", "database_id"], "cloudflare-kv-namespace": ["kv_namespaces", "id"] } as const

// Reads binding ids from a generated Wrangler config, keyed by resource kind and binding.
function readGeneratedWranglerIds(entries: readonly ViteHubProviderOutputEntry[]): Map<string, string> {
  const ids = new Map<string, string>()
  for (const entry of entries) {
    if (basename(entry.path) !== "wrangler.json" || !existsSync(entry.path) || !statSync(entry.path).isFile()) continue
    let config: unknown
    try {
      config = JSON.parse(readFileSync(entry.path, "utf8"))
    }
    catch {
      continue
    }
    if (!config || typeof config !== "object") continue
    for (const [kind, [field, idField]] of Object.entries(wranglerIdFields)) {
      const bindings: unknown = Reflect.get(config, field)
      if (!Array.isArray(bindings)) continue
      for (const binding of bindings) {
        const name: unknown = binding && typeof binding === "object" ? Reflect.get(binding, "binding") : undefined
        const id: unknown = binding && typeof binding === "object" ? Reflect.get(binding, idField) : undefined
        if (typeof name === "string" && typeof id === "string" && id && !ids.has(`${kind}:${name}`)) ids.set(`${kind}:${name}`, id)
      }
    }
  }
  return ids
}

function describeSource(resource: ViteHubResourceSummary): string {
  switch (resource.source) {
    case "config": return "config"
    case "env": return `env ${resource.env ?? ""}`.trim()
    case "name": return "bound by name"
    case "provider-output": return "generated provider output"
    case "provision-state": return PROVISION_STATE_FILE
    default: return "none"
  }
}

async function runResources(args: string[], context: InspectContext, plugins: readonly unknown[]): Promise<number> {
  const parsed = parseArgs(args, { kind: false })
  if (parsed.help) {
    context.stdout.write([
      `Usage: ${resourcesUsage}`,
      "",
      "Lists the host resources that Definitions and stores map to: D1, KV, R2, Queues, Vercel Blob, and the Sandbox Durable Object and Container.",
      "Shows each resource name, its id, and where the id came from: config, env, Provision State, generated provider output, or the host binds it by name.",
      "Reads local config and files only. It never calls a provider API.",
      "",
      "Options:",
      "  --json      Print machine-readable JSON.",
      "  -h, --help  Show this help.",
      "",
    ].join("\n"))
    return 0
  }
  if (parsed.error) {
    context.stderr.write(`${parsed.error}\nUsage: ${resourcesUsage}\n`)
    return 1
  }

  const generatedIds = readGeneratedWranglerIds(await collectViteHubProviderOutputEntries(plugins))
  const resources = (await collectViteHubResourceSummaries(plugins)).map((resource): ViteHubResourceSummary => {
    const generatedId = resource.id || !resource.binding ? undefined : generatedIds.get(`${resource.kind}:${resource.binding}`)
    return generatedId ? { ...resource, id: generatedId, source: "provider-output" } : resource
  })

  if (parsed.json) {
    writeJson(context, { resources })
    return 0
  }
  if (!resources.length) {
    context.stdout.write("No Definition maps to a host resource.\n")
    return 0
  }
  const lines: string[] = []
  for (const resource of resources) {
    lines.push(`${resource.host}\t${resource.kind}\t${resource.definition}`)
    if (resource.name) lines.push(`  Name: ${resource.name}`)
    if (resource.binding) lines.push(`  Binding: ${resource.binding}`)
    if (resource.id) lines.push(`  Id: ${String(redactInspectionValue(resource.id, "id"))}`)
    lines.push(`  Source: ${describeSource(resource)}`)
    if (resource.note) lines.push(`  Note: ${resource.note}`)
  }
  lines.push("")
  context.stdout.write(lines.join("\n"))
  return 0
}

/** One server route of the production build. */
interface RouteReport {
  /** The handler file: relative to the project root, or `<package>/<file>` for a file of another package. */
  handler: string
  /** `*` when the route answers every method. */
  method: string
  /** Middleware runs before the routes and passes the request on. */
  middleware?: true
  /** The ViteHub area of a generated handler, the package of a package file, or `app`. */
  owner: string
  route: string
}

function findPackage(file: string): { dir: string, name: string } | undefined {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = resolve(dir, "package.json")
    if (!existsSync(manifest)) continue
    const name: unknown = Reflect.get(Object(JSON.parse(readFileSync(manifest, "utf8"))), "name")
    if (typeof name === "string") return { dir, name }
  }
}

// Generated handlers live in `.vitehub/<area>/` or `.vitehub/nitro/<area>/`.
function routeHandler(rootDir: string, file: string): Pick<RouteReport, "handler" | "owner"> {
  const path = relative(rootDir, file)
  const generated = file.lastIndexOf("/.vitehub/")
  if (generated !== -1) {
    const [first, second] = file.slice(generated + "/.vitehub/".length).split("/")
    return { handler: path, owner: (first === "nitro" ? second : first) || "vite-hub" }
  }
  const owned = path.startsWith("..") || path.split("/").includes("node_modules") ? findPackage(file) : undefined
  return owned ? { handler: `${owned.name}/${relative(owned.dir, file)}`, owner: owned.name } : { handler: path, owner: "app" }
}

function readRoutes(rootDir: string, handlers: readonly unknown[]): RouteReport[] {
  const routes: RouteReport[] = []
  const seen = new Set<string>()
  for (const entry of handlers) {
    const handler: unknown = Reflect.get(Object(entry), "handler")
    if (typeof handler !== "string") continue
    const middleware = Reflect.get(Object(entry), "middleware") === true
    const route: unknown = Reflect.get(Object(entry), "route")
    const methods: unknown = Reflect.get(Object(entry), "method")
    const method = typeof methods === "string" ? methods.toUpperCase() : Array.isArray(methods) && methods.length ? methods.map(String).join(",").toUpperCase() : "*"
    const report: RouteReport = {
      ...(/^[#\u0000]/.test(handler) ? { handler, owner: "app" } : routeHandler(rootDir, resolve(rootDir, handler))),
      method,
      ...(middleware ? { middleware: true } : {}),
      route: typeof route === "string" && route ? route : "/**",
    }
    const key = `${report.method} ${report.route} ${report.handler} ${middleware}`
    if (seen.has(key)) continue
    seen.add(key)
    routes.push(report)
  }
  // Middleware runs first, so it comes first. Routes keep the order Nitro reads them in.
  return [...routes.filter(route => route.middleware), ...routes.filter(route => !route.middleware)]
}

async function runRoutes(args: string[], context: InspectContext, handlers: readonly unknown[]): Promise<number> {
  const parsed = parseArgs(args, { kind: false })
  if (parsed.help) {
    context.stdout.write([
      `Usage: ${routesUsage}`,
      "",
      "Lists the server routes and middleware that ViteHub and other Vite plugins add to the production build.",
      "Shows each method, path, owner, and handler file. Routes in server/routes and server/api are not listed.",
      "",
      "Options:",
      "  --json      Print machine-readable JSON.",
      "  -h, --help  Show this help.",
      "",
    ].join("\n"))
    return 0
  }
  if (parsed.error) {
    context.stderr.write(`${parsed.error}\nUsage: ${routesUsage}\n`)
    return 1
  }

  const routes = readRoutes(context.rootDir, handlers)
  if (parsed.json) {
    writeJson(context, { routes })
    return 0
  }
  if (!routes.length) {
    context.stdout.write("No plugin adds a server route.\n")
    return 0
  }
  const methodWidth = Math.max(6, ...routes.map(route => route.method.length))
  const routeWidth = Math.max(4, ...routes.map(route => route.route.length))
  const ownerWidth = Math.max(5, ...routes.map(route => route.owner.length))
  const lines = [`${"METHOD".padEnd(methodWidth)}  ${"PATH".padEnd(routeWidth)}  ${"OWNER".padEnd(ownerWidth)}  HANDLER`]
  for (const route of routes) {
    lines.push(`${route.method.padEnd(methodWidth)}  ${route.route.padEnd(routeWidth)}  ${route.owner.padEnd(ownerWidth)}  ${route.handler}${route.middleware ? "  (middleware)" : ""}`)
  }
  lines.push("")
  context.stdout.write(lines.join("\n"))
  return 0
}

/** Built-in namespace that renders package-owned inspection data. */
export function createInspectNamespace(plugins: readonly unknown[], operations: readonly AnyOperation[] = [], handlers: readonly unknown[] = []): ViteHubCliCommandNamespace {
  return {
    description: "Inspect discovered Definitions, host resources, server routes, and generated Provider Output.",
    features: [
      {
        description: "List Definitions discovered by each active package.",
        name: "definitions",
        run: (args, context) => runDefinitions(args, context, plugins, operations),
        usage: definitionsUsage,
      },
      {
        description: "List generated Provider Output files with secrets redacted.",
        name: "output",
        run: (args, context) => runProviderOutput(args, context, plugins),
        usage: providerOutputUsage,
      },
      {
        description: "List the host resources that Definitions map to and where their ids come from.",
        name: "resources",
        run: (args, context) => runResources(args, context, plugins),
        usage: resourcesUsage,
      },
      {
        description: "List the server routes that plugins add to the build, with method, path, and owner.",
        name: "routes",
        run: (args, context) => runRoutes(args, context, handlers),
        usage: routesUsage,
      },
    ],
    name: "inspect",
  }
}
