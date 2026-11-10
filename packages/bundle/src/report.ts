import { allocateBytes } from "./bytes.ts"
import { checkBundle } from "./checks.ts"
import { moduleGroup } from "./groups.ts"
import { explainRoute, routesOf } from "./routes.ts"

import type { BundleChainStep, BundleEnvironmentReport, BundleExplanation, BundleGroup, BundleModule, BundleReport, BundleRouteExplanation, BundleSide } from "./types.ts"

interface PlacedModule extends BundleModule {
  environment: string
  startup: boolean
}

/** The reports of the newest build. Reports that an older build left behind are ignored. */
export function latestBuild(reports: readonly BundleEnvironmentReport[]): BundleEnvironmentReport[] {
  const build = reports.map(report => report.build).sort().at(-1)
  return reports.filter(report => report.build === build).sort((left, right) => left.environment.localeCompare(right.environment))
}

function outputPath(report: BundleEnvironmentReport, file: string): string {
  return report.outDir === "." ? file : `${report.outDir}/${file}`
}

/**
 * A server build that bundles the output of another server build, such as Nitro bundling Nuxt's SSR output, holds that
 * output as opaque modules. This returns, for each such module, the inner environment and chunk.
 */
function innerOutputs(reports: readonly BundleEnvironmentReport[]): Map<string, { report: BundleEnvironmentReport, file: string }> {
  const outputs = new Map<string, { report: BundleEnvironmentReport, file: string }>()
  for (const report of reports) {
    if (report.side !== "server") continue
    for (const chunk of report.chunks) outputs.set(outputPath(report, chunk.file), { report, file: chunk.file })
  }
  return outputs
}

function isInner(report: BundleEnvironmentReport, reports: readonly BundleEnvironmentReport[]): boolean {
  if (report.side !== "server") return false
  const files = new Set(report.chunks.map(chunk => outputPath(report, chunk.file)))
  return reports.some(other => other !== report && other.side === "server" && other.chunks.some(chunk => chunk.modules.some(module => files.has(module.id))))
}

/** Every module of a side, with SSR output that Nitro bundles replaced by the SSR modules, scaled to Nitro's bytes. */
function placedModules(outer: readonly BundleEnvironmentReport[], all: readonly BundleEnvironmentReport[]): PlacedModule[] {
  const inner = innerOutputs(all.filter(report => !outer.includes(report)))
  const placed: PlacedModule[] = []
  for (const report of outer) {
    for (const chunk of report.chunks) {
      for (const module of chunk.modules) {
        const source = inner.get(module.id)
        const sourceChunk = source?.report.chunks.find(candidate => candidate.file === source.file)
        const total = sourceChunk?.modules.reduce((sum, part) => sum + part.bytes, 0) ?? 0
        if (!source || !sourceChunk || total === 0) {
          placed.push({ ...module, environment: report.environment, startup: chunk.startup })
          continue
        }
        const shares = allocateBytes(sourceChunk.modules.map(part => part.bytes), module.bytes)
        for (const [index, part] of sourceChunk.modules.entries()) {
          placed.push({ ...part, bytes: shares[index]!, environment: source.report.environment, startup: chunk.startup })
        }
      }
    }
  }
  return placed
}

function groupsOf(modules: readonly PlacedModule[]): BundleGroup[] {
  const groups = new Map<string, BundleGroup & { ids: Set<string> }>()
  for (const module of modules) {
    const { name, kind } = moduleGroup(module.id)
    const group = groups.get(name) ?? { name, kind, bytes: 0, startupBytes: 0, modules: 0, ids: new Set<string>() }
    group.bytes += module.bytes
    if (module.startup) group.startupBytes += module.bytes
    group.ids.add(module.id)
    groups.set(name, group)
  }
  return [...groups.values()]
    .map(({ ids, ...group }) => ({ ...group, modules: ids.size }))
    .sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name))
}

function sideOf(side: "client" | "server", reports: readonly BundleEnvironmentReport[]): BundleSide | undefined {
  const own = reports.filter(report => report.side === side)
  const outer = own.filter(report => !isInner(report, reports))
  if (!outer.length) return undefined
  const chunks = outer.flatMap(report => report.chunks)
  const startup = chunks.filter(chunk => chunk.startup)
  return {
    environments: own.map(report => report.environment),
    bytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
    gzip: chunks.reduce((sum, chunk) => sum + chunk.gzip, 0),
    chunks: chunks.length,
    startup: {
      bytes: startup.reduce((sum, chunk) => sum + chunk.bytes, 0),
      gzip: startup.reduce((sum, chunk) => sum + chunk.gzip, 0),
      chunks: startup.length,
    },
    groups: groupsOf(placedModules(outer, reports)),
    ...routesField(outer),
  }
}

function routesField(reports: readonly BundleEnvironmentReport[]): Pick<BundleSide, "routes" | "routesUnavailable"> {
  const unavailable = reports.find(report => report.routeOptions?.unavailable)?.routeOptions?.unavailable
  if (unavailable) return { routesUnavailable: unavailable }
  const routes = reports.flatMap(routesOf).sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path))
  return routes.length ? { routes } : {}
}

/** Joins the environment reports of one build into the report of the app. */
export function createBundleReport(reports: readonly BundleEnvironmentReport[]): BundleReport | undefined {
  const current = latestBuild(reports)
  if (!current.length) return undefined
  const client = sideOf("client", current)
  const server = sideOf("server", current)
  const host = current.find(report => report.host)?.host
  const findings = checkBundle(current, server, host, target => explainBundle(current, target))
  return { schemaVersion: 1, build: current[0]!.build, ...(host ? { host } : {}), ...(client ? { client } : {}), ...(server ? { server } : {}), findings }
}

function matches(id: string, target: string): boolean {
  if (id === target) return true
  if (id.startsWith("node_modules/")) {
    const group = moduleGroup(id).name
    if (group === target || id.startsWith(`node_modules/${target}/`)) return true
  }
  return !id.startsWith("node_modules/") && (id.startsWith(`${target}/`) || id.endsWith(`/${target}`))
}

/**
 * The shortest import chain from an entry of one environment to a module that matches. Static imports come first: a
 * module that loads at startup gets the chain that loads it, not a lazy one. Without a static chain, `import()` counts.
 */
function chainIn(report: BundleEnvironmentReport, found: (id: string) => boolean): string[] | undefined {
  return searchChain(report, found, false) ?? searchChain(report, found, true)
}

function searchChain(report: BundleEnvironmentReport, found: (id: string) => boolean, dynamic: boolean): string[] | undefined {
  // One id can sit in several chunks. Its edges are the union.
  const modules = new Map<string, { entry: boolean, next: Set<string> }>()
  for (const module of report.chunks.flatMap(chunk => chunk.modules)) {
    const row = modules.get(module.id) ?? { entry: false, next: new Set<string>() }
    row.entry ||= module.entry
    for (const next of dynamic ? [...module.imports, ...module.dynamicImports] : module.imports) row.next.add(next)
    modules.set(module.id, row)
  }
  const previous = new Map<string, string | undefined>()
  const queue = [...modules].filter(([, module]) => module.entry).map(([id]) => id)
  for (const id of queue) previous.set(id, undefined)
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!
    if (found(id)) {
      const chain = [id]
      for (let step = previous.get(id); step !== undefined; step = previous.get(step)) chain.unshift(step)
      return chain
    }
    for (const next of modules.get(id)?.next ?? []) {
      if (previous.has(next) || !modules.has(next)) continue
      previous.set(next, id)
      queue.push(next)
    }
  }
  return undefined
}

/**
 * Says why a package, a file, or a group is in the output: its bytes on each side, whether it loads at startup, and
 * the shortest import chain from the entry. A chain through Nuxt's SSR output continues inside the SSR build.
 */
export function explainBundle(reports: readonly BundleEnvironmentReport[], target: string): BundleExplanation[] {
  const current = latestBuild(reports)
  const explanations: BundleExplanation[] = []
  for (const side of ["client", "server"] as const) {
    const own = current.filter(report => report.side === side)
    const outer = own.filter(report => !isInner(report, current))
    const hits = placedModules(outer, current).filter(module => matches(module.id, target))
    if (!hits.length) continue
    const inner = own.filter(report => !outer.includes(report))
    let chain: BundleChainStep[] = []
    for (const report of outer) {
      const direct = chainIn(report, id => matches(id, target))
      if (direct) {
        chain = direct.map(id => ({ environment: report.environment, id }))
        break
      }
      for (const nested of inner) {
        const innerChain = chainIn(nested, id => matches(id, target))
        if (!innerChain) continue
        const entryFiles = new Set(nested.chunks.filter(chunk => chunk.entry).map(chunk => outputPath(nested, chunk.file)))
        const outerChain = chainIn(report, id => entryFiles.has(id))
        if (!outerChain) continue
        chain = [...outerChain.map(id => ({ environment: report.environment, id })), ...innerChain.map(id => ({ environment: nested.environment, id }))]
        break
      }
      if (chain.length) break
    }
    explanations.push({
      target: hits.find(module => module.id === target)?.id ?? chain.at(-1)?.id ?? hits[0]!.id,
      group: moduleGroup(hits[0]!.id).name,
      side,
      bytes: hits.reduce((sum, module) => sum + module.bytes, 0),
      startup: hits.some(module => module.startup),
      chain,
    })
  }
  return explanations
}

/**
 * Says what the browser loads on a first visit to a page route, such as `/docs/kv`: the startup files, the files of the
 * route's layout and pages, and the modules that the route adds. `undefined` when no route of the last build matches.
 */
export function explainBundleRoute(reports: readonly BundleEnvironmentReport[], target: string): BundleRouteExplanation | undefined {
  for (const report of latestBuild(reports)) {
    if (report.side !== "client") continue
    const explanation = explainRoute(report, target)
    if (explanation) return explanation
  }
  return undefined
}
