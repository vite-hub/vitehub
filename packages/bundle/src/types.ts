/** What put a module in the output. */
export type BundleGroupKind = "app" | "dependency" | "framework" | "generated" | "vitehub"

/** One source module in one output chunk. */
export interface BundleModule {
  /** Path relative to the project root, or `node_modules/<package>/<file>` for a dependency. */
  id: string
  /** The module's share of the chunk's output bytes. */
  bytes: number
  /** Modules that this module imports statically, by `id`. Only modules in the same build. */
  imports: string[]
  /** Modules that this module imports with `import()`, by `id`. */
  dynamicImports: string[]
  /** The module is an entry of the build. */
  entry: boolean
}

/** One JavaScript file that a build wrote. */
export interface BundleChunk {
  /** Path relative to the build's output folder. */
  file: string
  bytes: number
  gzip: number
  entry: boolean
  /** The file loads when the entry loads: the entry, and every file it imports statically. */
  startup: boolean
  /** Files that this file imports statically. The browser loads them with it. */
  imports?: string[]
  /** CSS files that load with this file. Client only. */
  css?: string[]
  modules: BundleModule[]
}

/** What one Vite environment or one Nitro build wrote. ViteHub writes one file for each to `.vitehub/bundle/`. */
export interface BundleEnvironmentReport {
  schemaVersion: 1
  /** Same for every environment of one build command. */
  build: string
  /** Vite environment name, such as `client` or `ssr`, or `nitro` for the server build. */
  environment: string
  side: "client" | "server"
  /** The output folder, relative to the project root. */
  outDir: string
  chunks: BundleChunk[]
  /** CSS files that the build wrote. Client only. */
  css?: BundleFile[]
  /** The page routes of the app and the components that render them. Client of a Nuxt app only. */
  routes?: BundleRouteSource[]
}

export interface BundleGroup {
  /** `@vite-hub/agent`, `vite-hub/console`, `h3`, `server/api`, `.nuxt`, ... */
  name: string
  kind: BundleGroupKind
  bytes: number
  /** Bytes of the group in files that load at startup. */
  startupBytes: number
  modules: number
}

export interface BundleSide {
  /** The environments that this side joins, such as `["nitro", "ssr"]`. */
  environments: string[]
  bytes: number
  gzip: number
  chunks: number
  startup: { bytes: number, gzip: number, chunks: number }
  /** Largest first. */
  groups: BundleGroup[]
  /** What a first visit to each page route loads, largest first. Client of a Nuxt app only. */
  routes?: BundleRoute[]
}

/** The output of one build, for the whole app. `vitehub bundle --json` prints it. */
export interface BundleReport {
  schemaVersion: 1
  build: string
  client?: BundleSide
  server?: BundleSide
}

/** One step of an import chain. */
export interface BundleChainStep {
  environment: string
  id: string
}

export interface BundleExplanation {
  /** The module that matched, by `id`. */
  target: string
  group: string
  side: "client" | "server"
  bytes: number
  startup: boolean
  /** From the build entry to the target. */
  chain: BundleChainStep[]
}

/** One file that a build wrote, with its size. */
export interface BundleFile {
  /** Path relative to the build's output folder. */
  file: string
  bytes: number
  gzip: number
}

/** A page route and the components that render it, as the framework resolves them. */
export interface BundleRouteSource {
  /** The route path, such as `/docs/:slug()`. */
  path: string
  /** The layout and the page components of the route, outermost first, by module `id`. */
  components: string[]
}

/** One file that a first visit to a route loads. */
export interface BundleRouteFile extends BundleFile {
  /** The file loads on every page because the entry imports it. */
  startup: boolean
}

/**
 * What the browser loads on a first visit to a page route: the startup files, and the files of the route's layout and
 * page components with every file that they import statically. Files that the page loads later with `import()` do not
 * count.
 */
export interface BundleRoute extends BundleRouteSource {
  /** JavaScript bytes of a first visit. */
  bytes: number
  gzip: number
  /** The part of `bytes` that only some routes load: the files that are not startup files. */
  pageBytes: number
  /** CSS bytes of a first visit. Nuxt can inline some of this CSS in the HTML. */
  cssBytes: number
  /** JavaScript and CSS files, largest first. */
  files: BundleRouteFile[]
}

/** A module in a file that only some routes load. */
export interface BundleRouteModule {
  id: string
  /** The output file that holds the module. */
  file: string
  bytes: number
}

export interface BundleRouteExplanation {
  /** The path that was asked for, such as `/docs/kv`. */
  target: string
  route: BundleRoute
  /** Modules of the files that are not startup files, largest first. They are what the route adds. */
  modules: BundleRouteModule[]
}
