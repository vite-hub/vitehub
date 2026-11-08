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

/** Bytes of a side, as `vitehub bundle --against` compares them. */
export interface BundleTotals {
  bytes: number
  gzip: number
  startupBytes: number
  startupGzip: number
}

/** Bytes of a group, as `vitehub bundle --against` compares them. */
export interface BundleGroupSize {
  bytes: number
  startupBytes: number
}

/**
 * A group that changed between two builds. `added` and `removed` mean that the group is in one build only. Otherwise
 * the total bytes decide between `grew` and `shrank`, and the startup bytes decide when the total did not change.
 */
export interface BundleGroupChange {
  name: string
  kind: BundleGroupKind
  change: "added" | "removed" | "grew" | "shrank"
  before: BundleGroupSize
  after: BundleGroupSize
  /** `after` minus `before`. */
  delta: BundleGroupSize
}

/** One side of two builds. A side that a build does not have counts as 0 bytes. */
export interface BundleSideComparison {
  before: BundleTotals
  after: BundleTotals
  /** `after` minus `before`. */
  delta: BundleTotals
  /** Only the groups that changed, the largest change first. */
  groups: BundleGroupChange[]
}

/** What changed from one build to the next. `vitehub bundle --against <saved report> --json` prints it. */
export interface BundleComparison {
  schemaVersion: 1
  builds: { before: string, after: string }
  client?: BundleSideComparison
  server?: BundleSideComparison
}
