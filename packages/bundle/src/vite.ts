import { resolve } from "node:path"

import { resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"

import { bundleCliContributor } from "./cli.ts"
import { collectEnvironmentReport } from "./collect.ts"
import { writeEnvironmentReport } from "./files.ts"

import type { ViteHubCliPluginMetadata } from "@vite-hub/internal/cli"
import type { Plugin } from "vite"
import type { ModuleInfoLike } from "./collect.ts"

interface BundlerConfig { plugins?: unknown }

/** The parts of a Nitro 3 instance that the server report reads. */
interface NitroLike {
  hooks: { hook: (name: "build:config", callback: (nitro: unknown, config: { rolldown?: BundlerConfig, rollup?: BundlerConfig }) => void) => void }
  options: { builder?: string, dev: boolean, rootDir: string }
}

interface BundleNitroModule {
  name: string
  setup: (nitro: NitroLike) => void
}

export type BundleVitePlugin = Plugin & { nitro: BundleNitroModule, vitehub: ViteHubCliPluginMetadata }

interface OutputContext {
  getModuleInfo: (id: string) => ModuleInfoLike | null
}

interface BuildState {
  id: string
  /** `<environment>\0<outDir>` of the reports that this build already wrote. */
  written: Set<string>
}

const buildKey = Symbol.for("vitehub.bundle.build")

/** One id for every environment that one process builds for a project, so the reader can join them. */
function buildState(root: string): BuildState {
  const builds = (Reflect.get(globalThis, buildKey) ?? new Map<string, BuildState>()) as Map<string, BuildState>
  Reflect.set(globalThis, buildKey, builds)
  const state = builds.get(root) ?? { id: new Date().toISOString(), written: new Set<string>() }
  builds.set(root, state)
  return state
}

function writeReport(context: OutputContext, bundle: Record<string, unknown>, options: { environment: string, outDir: string, root: string, side: "client" | "server" }): void {
  // Nitro's rootDir can end with a slash, and Vite's root can be Nuxt's srcDir. Both must name the same build.
  const root = resolve(options.root)
  const outDir = resolve(options.outDir)
  const state = buildState(root)
  // In Nuxt 5, the Vite plugin and the Nitro module can both see the server build.
  const key = `${options.environment}\0${outDir}`
  if (state.written.has(key)) return
  state.written.add(key)
  writeEnvironmentReport(root, collectEnvironmentReport(bundle, {
    ...options,
    build: state.id,
    getModuleInfo: id => context.getModuleInfo(id),
    outDir,
    root,
  }))
}

/** Adds a Rolldown plugin to a Nitro build that bundles on its own, such as the server build of Nuxt 5. */
function bundleNitroModule(): BundleNitroModule {
  return {
    name: "@vite-hub/bundle/nitro",
    setup(nitro) {
      // With `nitro/vite`, the server is a Vite environment and the Vite plugin reads it.
      if (nitro.options.dev || nitro.options.builder === "vite") return
      const root = nitro.options.rootDir
      nitro.hooks.hook("build:config", (_nitro, config) => {
        const bundler = config.rolldown ?? config.rollup
        if (!bundler) return
        const plugins = Array.isArray(bundler.plugins) ? bundler.plugins : bundler.plugins ? [bundler.plugins] : []
        bundler.plugins = [...plugins, {
          name: "@vite-hub/bundle/nitro-report",
          writeBundle(this: OutputContext, output: { dir?: string }, bundle: Record<string, unknown>) {
            writeReport(this, bundle, { environment: "nitro", outDir: output.dir ?? root, root, side: "server" })
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
export function hubBundle(): BundleVitePlugin {
  return {
    name: "@vite-hub/bundle/vite",
    enforce: "post",
    writeBundle(output, bundle) {
      const environment = this.environment
      const config = environment.config
      writeReport(this, bundle as Record<string, unknown>, {
        environment: environment.name,
        outDir: output.dir ?? resolve(config.root, config.build.outDir),
        root: resolveViteHubProjectRoot(config.root),
        side: config.consumer === "server" ? "server" : "client",
      })
    },
    nitro: bundleNitroModule(),
    vitehub: { cli: bundleCliContributor },
  }
}
