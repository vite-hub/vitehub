import { createRouterMatcher } from "vue-router"

import type { BundleEnvironmentReport, BundleRoute, BundleRouteExplanation, BundleRouteFile, BundleRouteModule, BundleRouteOptions, BundleRouteSource } from "./types.ts"

/** A page route with the absolute files of the components that render it, outermost first. */
export interface PageRoute {
  path: string
  files: string[]
  /** Include this layout only when the route also loads its renderer. */
  layout?: { file: string, component: string }
  /** Suppress route estimates for this build when a route cannot be measured safely. */
  unavailable?: string
}

/** The parts of a Nuxt page that the report reads. */
export interface NuxtPageLike {
  path: string
  alias?: string | string[]
  file?: string
  /** Named views, including `default`. */
  components?: Record<string, string>
  redirect?: unknown
  meta?: { layout?: unknown, redirect?: unknown }
  children?: NuxtPageLike[]
}

function joinPath(parent: string, path: string): string {
  if (path.startsWith("/")) return path
  if (!path) return parent
  return `${parent.replace(/\/$/, "")}/${path}`
}

/**
 * The routes of a Nuxt app, from the pages that Nuxt resolves and the layouts that it finds. A nested route renders
 * every parent page. The layout is the last static `layout` in the page meta of the route, or `default`. A layout
 * that the app sets at runtime is not known at build time.
 */
export function nuxtPageRoutes(pages: readonly NuxtPageLike[], layouts: Readonly<Record<string, { file: string }>> = {}, layoutComponent?: string): PageRoute[] {
  const routes = new Map<string, PageRoute>()
  const walk = (list: readonly NuxtPageLike[], parentPaths: string[], parentFiles: string[], parentLayout: unknown) => {
    for (const page of list) {
      const aliases = typeof page.alias === "string" ? [page.alias] : page.alias ?? []
      const paths = [...new Set(parentPaths.flatMap(parent => [page.path, ...aliases].map(path => joinPath(parent, path))))]
      const own = page.components ? Object.values(page.components) : page.file ? [page.file] : []
      const files = [...parentFiles, ...own]
      const layout = typeof page.meta?.layout === "string" || page.meta?.layout === false ? page.meta.layout : parentLayout
      const redirect = page.redirect ?? page.meta?.redirect
      if (own.length || redirect !== undefined) {
        const layoutFile = typeof layout === "string" ? layouts[layout]?.file : undefined
        // A child with the same path, such as `index.vue` in a folder, renders instead of its parent alone.
        for (const path of paths) routes.set(path, {
          path,
          files: layoutFile ? [layoutFile, ...files] : files,
          ...(layoutFile && layoutComponent ? { layout: { file: layoutFile, component: layoutComponent } } : {}),
          ...(redirect !== undefined ? { unavailable: "Page redirects can change the route before its components render." } : {}),
        })
      }
      if (page.children?.length) walk(page.children, paths, files, layout)
    }
  }
  walk(pages, [""], [], "default")
  return [...routes.values()].sort((left, right) => left.path < right.path ? -1 : 1)
}

interface RouteGraph {
  report: BundleEnvironmentReport
  byFile: Map<string, BundleEnvironmentReport["chunks"][number]>
  /** The files that hold each module. */
  holders: Map<string, string[]>
  startup: string[]
}

function graphOf(report: BundleEnvironmentReport): RouteGraph {
  const holders = new Map<string, string[]>()
  for (const chunk of report.chunks) {
    for (const module of chunk.modules) holders.set(module.id, [...holders.get(module.id) ?? [], chunk.file])
  }
  return {
    report,
    byFile: new Map(report.chunks.map(chunk => [chunk.file, chunk])),
    holders,
    startup: report.chunks.filter(chunk => chunk.startup).map(chunk => chunk.file),
  }
}

/** The JavaScript files that a first visit loads: the startup files and the component files with their static imports. */
function routeFiles(graph: RouteGraph, source: BundleRouteSource): Set<string> {
  const files = new Set(graph.startup)
  const pending = source.components.flatMap(id => graph.holders.get(id) ?? [])
  while (pending.length) {
    const file = pending.pop()!
    if (files.has(file)) continue
    files.add(file)
    pending.push(...graph.byFile.get(file)?.imports ?? [])
  }
  return files
}

function routeOf(graph: RouteGraph, source: BundleRouteSource): BundleRoute {
  const files = [...routeFiles(graph, source)].flatMap(file => graph.byFile.get(file) ?? [])
  const cssSizes = new Map((graph.report.css ?? []).map(file => [file.file, file]))
  const css = new Map<string, boolean>()
  for (const chunk of files) for (const file of chunk.css ?? []) css.set(file, (css.get(file) ?? false) || chunk.startup)
  const js: BundleRouteFile[] = files.map(chunk => ({ file: chunk.file, bytes: chunk.bytes, gzip: chunk.gzip, startup: chunk.startup }))
  const styles: BundleRouteFile[] = [...css].flatMap(([file, startup]) => {
    const size = cssSizes.get(file)
    return size ? [{ ...size, startup }] : []
  })
  return {
    path: source.path,
    components: source.components,
    bytes: js.reduce((sum, file) => sum + file.bytes, 0),
    gzip: js.reduce((sum, file) => sum + file.gzip, 0),
    pageBytes: js.filter(file => !file.startup).reduce((sum, file) => sum + file.bytes, 0),
    cssBytes: styles.reduce((sum, file) => sum + file.bytes, 0),
    files: [...js, ...styles].sort((left, right) => right.bytes - left.bytes || left.file.localeCompare(right.file)),
  }
}

/** What a first visit to each route of a client report loads, largest first. */
export function routesOf(report: BundleEnvironmentReport): BundleRoute[] {
  if (report.routeOptions?.unavailable || !report.routes?.length) return []
  const graph = graphOf(report)
  return report.routes.map(source => routeOf(graph, source))
    .sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path))
}

/** The route that renders `target`, using Vue Router's path grammar and ranking. */
export function matchRoute<T extends { path: string }>(routes: readonly T[], target: string, options: BundleRouteOptions = {}): T | undefined {
  if (options.unavailable) return undefined
  const path = target.replace(/[?#].*$/, "")
  const matcher = createRouterMatcher(routes.map((route, index) => ({ path: route.path, name: String(index), children: [] })), options)
  const match = matcher.getRoutes().find(route => route.re.test(path))
  return match ? routes[Number(match.record.name)] : undefined
}

/** What a first visit to the route that renders `target` loads, and the modules of its page files. */
export function explainRoute(report: BundleEnvironmentReport, target: string): BundleRouteExplanation | undefined {
  const source = matchRoute(report.routes ?? [], target, report.routeOptions)
  if (!source) return undefined
  const graph = graphOf(report)
  const route = routeOf(graph, source)
  const modules: BundleRouteModule[] = route.files
    .filter(file => !file.startup)
    .flatMap(file => graph.byFile.get(file.file)?.modules.map(module => ({ id: module.id, file: file.file, bytes: module.bytes })) ?? [])
    .sort((left, right) => right.bytes - left.bytes || left.id.localeCompare(right.id))
  return { target, route, modules }
}
