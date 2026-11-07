import { randomUUID } from "node:crypto"
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

export type BundleVitePlugin = Plugin & {
  /** Frameworks such as Nuxt start one session before running their Vite and Nitro phases. */
  api: { startBuild: () => string }
  nitro: BundleNitroModule
  vitehub: ViteHubCliPluginMetadata
}

export interface BundleViteOptions {
  /** A coordinator can pass the same fresh ID to phases running in separate processes. */
  buildId?: string
}

interface OutputContext {
  getModuleInfo: (id: string) => ModuleInfoLike | null
}

const outputsKey = Symbol.for("vitehub.bundle.outputs")

/** Vite and Nitro can observe the same output; only that output object is deduplicated. */
function writtenOutputs(): WeakMap<object, Set<string>> {
  const outputs = (Reflect.get(globalThis, outputsKey) ?? new WeakMap<object, Set<string>>()) as WeakMap<object, Set<string>>
  Reflect.set(globalThis, outputsKey, outputs)
  return outputs
}

function newBuildId(): string {
  return `${new Date().toISOString()}-${randomUUID()}`
}

function writeReport(context: OutputContext, bundle: Record<string, unknown>, options: { build: string, environment: string, outDir: string, root: string, side: "client" | "server" }): void {
  // Nitro's rootDir can end with a slash, and Vite's root can be Nuxt's srcDir. Both must name the same build.
  const root = resolve(options.root)
  const outDir = resolve(options.outDir)
  const outputs = writtenOutputs()
  const written = outputs.get(bundle) ?? new Set<string>()
  // In Nuxt 5, the Vite plugin and the Nitro module can both see the server build.
  const key = `${root}\0${options.build}\0${options.environment}\0${outDir}`
  if (written.has(key)) return
  writeEnvironmentReport(root, collectEnvironmentReport(bundle, {
    ...options,
    getModuleInfo: id => context.getModuleInfo(id),
    outDir,
    root,
  }))
  written.add(key)
  outputs.set(bundle, written)
}

/** Adds a Rolldown plugin to a Nitro build that bundles on its own, such as the server build of Nuxt 5. */
function bundleNitroModule(buildId: () => string | undefined): BundleNitroModule {
  return {
    name: "@vite-hub/bundle/nitro",
    setup(nitro) {
      // With `nitro/vite`, the server is a Vite environment and the Vite plugin reads it.
      if (nitro.options.dev || nitro.options.builder === "vite") return
      const root = nitro.options.rootDir
      nitro.hooks.hook("build:config", (_nitro, config) => {
        const bundler = config.rolldown ?? config.rollup
        if (!bundler) return
        const build = newBuildId()
        const plugins = Array.isArray(bundler.plugins) ? bundler.plugins : bundler.plugins ? [bundler.plugins] : []
        bundler.plugins = [...plugins, {
          name: "@vite-hub/bundle/nitro-report",
          writeBundle(this: OutputContext, output: { dir?: string }, bundle: Record<string, unknown>) {
            writeReport(this, bundle, { build: buildId() ?? build, environment: "nitro", outDir: output.dir ?? root, root, side: "server" })
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
      // Standalone build() calls get new environments; watch rebuilds update the same session.
      if (!builds.has(this.environment)) builds.set(this.environment, coordinatedBuild ?? newBuildId())
    },
    writeBundle(output, bundle) {
      const environment = this.environment
      const config = environment.config
      writeReport(this, bundle as Record<string, unknown>, {
        build: coordinatedBuild ?? builds.get(environment)!,
        environment: environment.name,
        outDir: output.dir ?? resolve(config.root, config.build.outDir),
        root: resolveViteHubProjectRoot(config.root),
        side: config.consumer === "server" ? "server" : "client",
      })
    },
    api: {
      startBuild() {
        coordinatedBuild = newBuildId()
        return coordinatedBuild
      },
    },
    nitro: bundleNitroModule(() => coordinatedBuild),
    vitehub: { cli: bundleCliContributor },
  }
}
