import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import type { ConfigEnv, InlineConfig, ResolvedConfig } from "vite"

const configExtensions = ["js", "mjs", "cjs", "ts", "mts", "cts"]

function hasConfig(rootDir: string, name: string): boolean {
  return configExtensions.some(extension => existsSync(join(rootDir, `${name}.config.${extension}`)))
}

type ResolveViteConfig = (
  inlineConfig: InlineConfig,
  command: ConfigEnv["command"],
  mode: string,
) => Promise<Pick<ResolvedConfig, "plugins" | "root">>

type LoadNuxt = (options: {
  cwd: string
  dev: boolean
  overrides: { devtools: { enabled: false }, vitehubCliDiscovery: true }
  ready: true
}) => Promise<{
  close?: () => Promise<void> | void
  options: {
    rootDir?: string
    vite?: InlineConfig
  }
}>

async function resolveNuxtLoader(rootDir: string): Promise<LoadNuxt> {
  const require = createRequire(join(rootDir, "package.json"))
  // SAFETY: nuxt/kit owns this public loadNuxt export and require.resolve selects that installed module.
  const module = await import(pathToFileURL(require.resolve("nuxt/kit")).href) as { loadNuxt: LoadNuxt }
  return module.loadNuxt
}

async function defaultResolveViteConfig(
  inlineConfig: InlineConfig,
  command: ConfigEnv["command"],
  mode: string,
): Promise<Pick<ResolvedConfig, "plugins" | "root">> {
  const { resolveConfig } = await import("vite")
  return await resolveConfig(inlineConfig, command, mode)
}

export async function loadViteHubCliConfig(
  rootDir: string,
  command: ConfigEnv["command"] = "serve",
  dependencies: {
    loadNuxt?: LoadNuxt
    resolveViteConfig?: ResolveViteConfig
  } = {},
): Promise<Pick<ResolvedConfig, "plugins" | "root"> & { vitehubConfigResolved: true }> {
  const mode = command === "build" ? "production" : "development"
  const resolveViteConfig = dependencies.resolveViteConfig ?? defaultResolveViteConfig
  if (!hasConfig(rootDir, "nuxt")) {
    return {
      // SAFETY: vitehubCliDiscovery is an internal marker consumed by ViteHub's plugin before Vite reads the config.
      ...await resolveViteConfig({ root: rootDir, vitehubCliDiscovery: true } as InlineConfig, command, mode),
      vitehubConfigResolved: true,
    }
  }

  const loadNuxt = dependencies.loadNuxt ?? await resolveNuxtLoader(rootDir)
  const nuxt = await loadNuxt({
    cwd: rootDir,
    dev: command === "serve",
    overrides: { devtools: { enabled: false }, vitehubCliDiscovery: true },
    ready: true,
  })
  try {
    const nuxtRoot = nuxt.options.rootDir || rootDir
    const viteRoot = resolve(nuxtRoot, typeof nuxt.options.vite?.root === "string" ? nuxt.options.vite.root : nuxtRoot)
    return {
      // SAFETY: vitehubCliDiscovery is an internal marker consumed by ViteHub's plugin before Vite reads the config.
      ...await resolveViteConfig({
        ...nuxt.options.vite,
        configFile: false,
        root: viteRoot,
        vitehubCliDiscovery: true,
      } as InlineConfig, command, mode),
      vitehubConfigResolved: true,
    }
  }
  finally {
    await nuxt.close?.()
  }
}
