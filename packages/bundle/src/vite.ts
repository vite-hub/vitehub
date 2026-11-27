import { randomUUID } from "node:crypto"
import { dirname, resolve } from "node:path"

import { ownModule } from "@vite-hub/internal/build/paths"
import { resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"

import { bundleCliContributor } from "./cli.ts"
import { collectEnvironmentReport } from "./collect.ts"
import { writeBundleReportRoot, writeEnvironmentReport } from "./files.ts"

import type { ViteHubCliPluginMetadata } from "@vite-hub/internal/cli"
import type { OperationContributionEntry } from "@vite-hub/internal/operations"
import type { Plugin } from "vite"
import type { ModuleInfoLike } from "./collect.ts"
import type { PageRoute } from "./routes.ts"
import type { BundleRouteOptions, BundleStartupRule } from "./types.ts"

interface BundlerConfig { plugins?: unknown }

interface NitroLike {
  hooks: {
    hook: (name: "build:config", callback: (nitro: unknown, config: { rolldown?: BundlerConfig, rollup?: BundlerConfig }) => void) => void
    callHook: (name: "vitehub:bundle:rules", rules: BundleStartupRule[]) => Promise<unknown> | unknown
  }
  options: { builder?: string, dev: boolean, preset?: string, rootDir: string }
}

interface ServerFacts {
  host?: string
  rules: BundleStartupRule[]
}

interface BundleNitroModule {
  name: string
  setup: (nitro: NitroLike) => void
}

export type BundleVitePlugin = Plugin & {
  api: {
    /** The page routes of the app. The client report keeps them, so `vitehub bundle` can say what each route loads. */
    setRoutes: (routes: PageRoute[], options?: BundleRouteOptions) => void
    /** Frameworks such as Nuxt start one session before running their Vite and Nitro phases. */
    startBuild: () => string
  }
  nitro: BundleNitroModule
  vitehub: ViteHubCliPluginMetadata & { operations: readonly OperationContributionEntry[] }
}

export interface BundleViteOptions {
  /** A coordinator can pass the same fresh ID to phases running in separate processes. */
  buildId?: string
}

interface OutputContext {
  getModuleInfo: (id: string) => ModuleInfoLike | null
}

const outputsKey = Symbol.for("vitehub.bundle.outputs")

function writtenOutputs(): WeakMap<object, Set<string>> {
  const outputs = (Reflect.get(globalThis, outputsKey) ?? new WeakMap<object, Set<string>>()) as WeakMap<object, Set<string>>
  Reflect.set(globalThis, outputsKey, outputs)
  return outputs
}

function newBuildId(): string {
  return `${new Date().toISOString()}-${randomUUID()}`
}

async function serverFacts(nitro: NitroLike | undefined): Promise<ServerFacts> {
  const rules: BundleStartupRule[] = []
  if (!nitro) return { rules }
  await nitro.hooks.callHook("vitehub:bundle:rules", rules)
  return { ...(nitro.options.preset ? { host: nitro.options.preset } : {}), rules }
}

function writeReport(context: OutputContext, bundle: Record<string, unknown>, options: { build: string, configRoot?: string, environment: string, outDir: string, root: string, routes?: PageRoute[], routeOptions?: BundleRouteOptions, side: "client" | "server" }, facts?: ServerFacts): void {
  const root = resolve(options.root)
  const outDir = resolve(options.outDir)
  const outputs = writtenOutputs()
  const written = outputs.get(bundle) ?? new Set<string>()
  const key = `${root}\0${options.build}\0${options.environment}\0${outDir}`
  if (written.has(key)) return
  const { chunks, ...report } = collectEnvironmentReport(bundle, {
    ...options,
    getModuleInfo: id => context.getModuleInfo(id),
    outDir,
    root,
  })
  writeEnvironmentReport(root, { ...report, ...(facts?.host ? { host: facts.host } : {}), ...(facts?.rules.length ? { rules: facts.rules } : {}), chunks })
  for (const cliRoot of new Set([root, process.cwd(), ...options.configRoot ? [options.configRoot] : []])) {
    writeBundleReportRoot(cliRoot, root)
  }
  written.add(key)
  outputs.set(bundle, written)
}

function bundleNitroModule(buildId: () => string | undefined, onSetup: (nitro: NitroLike) => void): BundleNitroModule {
  return {
    name: "@vite-hub/bundle/nitro",
    setup(nitro) {
      if (!nitro.options.dev) onSetup(nitro)
      if (nitro.options.dev || nitro.options.builder === "vite") return
      const root = nitro.options.rootDir
      nitro.hooks.hook("build:config", (_nitro, config) => {
        const bundler = config.rolldown ?? config.rollup
        if (!bundler) return
        const build = newBuildId()
        const plugins = Array.isArray(bundler.plugins) ? bundler.plugins : bundler.plugins ? [bundler.plugins] : []
        bundler.plugins = [...plugins, {
          name: "@vite-hub/bundle/nitro-report",
          async writeBundle(this: OutputContext, output: { dir?: string }, bundle: Record<string, unknown>) {
            writeReport(this, bundle, { build: buildId() ?? build, environment: "nitro", outDir: output.dir ?? root, root, side: "server" }, await serverFacts(nitro))
          },
        }]
      })
    },
  }
}

/**
 * Writes a bundle report for each build environment to `.vitehub/bundle/`. `vitehub bundle` joins them into one
 * report for the app. Builds without the plugin write nothing.
 */
export function hubBundle(options: BundleViteOptions = {}): BundleVitePlugin {
  let coordinatedBuild = options.buildId
  const builds = new WeakMap<object, string>()
  let routes: PageRoute[] = []
  let routeOptions: BundleRouteOptions | undefined
  let nitro: NitroLike | undefined
  return {
    name: "@vite-hub/bundle/vite",
    enforce: "post",
    sharedDuringBuild: true,
    buildApp: {
      order: "pre",
      async handler(builder) {
        const build = coordinatedBuild ?? newBuildId()
        for (const environment of Object.values(builder.environments)) builds.set(environment, build)
      },
    },
    buildStart() {
      if (!builds.has(this.environment)) builds.set(this.environment, coordinatedBuild ?? newBuildId())
    },
    async writeBundle(output, bundle) {
      const environment = this.environment
      const config = environment.config
      const side = config.consumer === "server" ? "server" : "client"
      writeReport(this, bundle as Record<string, unknown>, {
        build: coordinatedBuild ?? builds.get(environment)!,
        ...(config.configFile ? { configRoot: dirname(config.configFile) } : {}),
        environment: environment.name,
        routes,
        routeOptions,
        outDir: output.dir ?? resolve(config.root, config.build.outDir),
        root: resolveViteHubProjectRoot(config.root),
        side,
      }, side === "server" ? await serverFacts(nitro) : undefined)
    },
    api: {
      setRoutes(next, options) {
        routes = next
        routeOptions = options
      },
      startBuild() {
        coordinatedBuild = newBuildId()
        return coordinatedBuild
      },
    },
    nitro: bundleNitroModule(() => coordinatedBuild, (instance) => { nitro = instance }),
    vitehub: {
      cli: bundleCliContributor,
      operations: [{ export: "bundleOperations", load: async () => (await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./operations.ts" : "./operations.js")).bundleOperations, module: ownModule(import.meta.url, "operations") }],
    },
  }
}

export { nuxtPageRoutes } from "./routes.ts"
export type { NuxtPageLike, PageRoute } from "./routes.ts"
