import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import type { InlineConfig, ResolvedConfig } from "vite"

const configExtensions = ["js", "mjs", "cjs", "ts", "mts", "cts"]

function hasConfig(rootDir: string, name: string): boolean {
  return configExtensions.some(extension => existsSync(join(rootDir, `${name}.config.${extension}`)))
}

type ResolveViteConfig = (
  inlineConfig: InlineConfig,
  command: "serve",
  mode: string,
) => Promise<Pick<ResolvedConfig, "plugins" | "root">>

type LoadNuxt = (options: {
  cwd: string
  dev: true
  overrides: { vitehubCliDiscovery: true }
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
  command: "serve",
  mode: string,
): Promise<Pick<ResolvedConfig, "plugins" | "root">> {
  const { resolveConfig } = await import("vite")
  return await resolveConfig(inlineConfig, command, mode)
}

export async function loadViteHubCliConfig(
  rootDir: string,
  dependencies: {
    loadNuxt?: LoadNuxt
    resolveViteConfig?: ResolveViteConfig
  } = {},
): Promise<Pick<ResolvedConfig, "plugins" | "root"> & { vitehubConfigResolved: true }> {
  const resolveViteConfig = dependencies.resolveViteConfig ?? defaultResolveViteConfig
  if (hasConfig(rootDir, "vite") || !hasConfig(rootDir, "nuxt")) {
    return {
      ...await resolveViteConfig({ root: rootDir, vitehubCliDiscovery: true } as InlineConfig, "serve", "development"),
      vitehubConfigResolved: true,
    }
  }

  const loadNuxt = dependencies.loadNuxt ?? await resolveNuxtLoader(rootDir)
  const nuxt = await loadNuxt({
    cwd: rootDir,
    dev: true,
    overrides: { vitehubCliDiscovery: true },
    ready: true,
  })
  try {
    const nuxtRoot = nuxt.options.rootDir || rootDir
    const viteRoot = resolve(nuxtRoot, nuxt.options.vite?.root ?? nuxtRoot)
    return {
      ...await resolveViteConfig({
        ...nuxt.options.vite,
        configFile: false,
        root: viteRoot,
        vitehubCliDiscovery: true,
      } as InlineConfig, "serve", "development"),
      vitehubConfigResolved: true,
    }
  }
  finally {
    await nuxt.close?.()
  }
}
