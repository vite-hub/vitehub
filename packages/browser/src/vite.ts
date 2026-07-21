import { getViteMode } from "@vite-hub/internal/build/mode"
import { createDefaultCloudflareOutputRoot, writeCloudflareWranglerConfig } from "@vite-hub/internal/build/cloudflare"
import { createNoExternalMerger, isServerEnvironment, shouldSkipViteProviderBuild } from "@vite-hub/internal/build/vite"

import type { Plugin, ResolvedConfig } from "vite"

export interface BrowserModuleOptions {
  binding?: string
  provider?: "cloudflare"
}

export type BrowserVitePlugin = Plugin & {
  api: {
    getConfig(): Required<BrowserModuleOptions>
  }
}

const mergeNoExternal = createNoExternalMerger("@vite-hub/browser")

function resolveOptions(options: BrowserModuleOptions | false | undefined): Required<BrowserModuleOptions> {
  if (options === false) return { binding: "BROWSER", provider: "cloudflare" }
  const binding = options?.binding || "BROWSER"
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding)) {
    throw new TypeError("[vitehub:browser] Browser binding must be a valid Cloudflare binding name.")
  }
  if (options?.provider && options.provider !== "cloudflare") {
    throw new TypeError("[vitehub:browser] hubBrowser() currently supports the Cloudflare provider.")
  }
  return { binding, provider: "cloudflare" }
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {}
}

function mergeNitroExternal(value: unknown, addition: string): unknown {
  if (typeof value === "undefined") return [addition]
  if (Array.isArray(value)) return value.includes(addition) ? [...value] : [...value, addition]
  if (typeof value === "string" || value instanceof RegExp) return [value, addition]
  if (typeof value === "function") {
    return (source: string, importer?: string, isResolved?: boolean) => source === addition || Boolean(value(source, importer, isResolved))
  }
  return value
}

function configureNitroBrowser(value: unknown, options: Required<BrowserModuleOptions>, enabled: boolean): Record<string, unknown> {
  const nitro = cloneRecord(value)
  const cloudflare = cloneRecord(nitro.cloudflare)
  const wrangler = cloneRecord(cloudflare.wrangler)
  const rollupConfig = cloneRecord(nitro.rollupConfig)
  if (!enabled) {
    delete wrangler.browser
    return { ...nitro, cloudflare: { ...cloudflare, wrangler } }
  }
  const flags = Array.isArray(wrangler.compatibility_flags) ? [...wrangler.compatibility_flags] : []
  if (!flags.includes("nodejs_compat")) flags.push("nodejs_compat")
  return {
    ...nitro,
    cloudflare: {
      ...cloudflare,
      wrangler: {
        ...wrangler,
        browser: { binding: options.binding },
        compatibility_flags: flags,
      },
    },
    rollupConfig: { ...rollupConfig, external: mergeNitroExternal(rollupConfig.external, "cloudflare:workers") },
  }
}

export function hubBrowser(options?: BrowserModuleOptions | false): BrowserVitePlugin {
  let enabled = options !== false
  let resolvedOptions = resolveOptions(options)
  let resolved: ResolvedConfig | undefined
  const applyConfig = (config: { browser?: BrowserModuleOptions | false, nitro?: unknown }) => {
    const configured = config.browser ?? options
    enabled = configured !== false
    resolvedOptions = resolveOptions(configured)
    config.nitro = configureNitroBrowser(config.nitro, resolvedOptions, enabled)
  }
  return {
    name: "@vite-hub/browser/vite",
    enforce: "pre",
    api: { getConfig: () => resolvedOptions },
    config(config) {
      applyConfig(config)
    },
    configResolved(config) {
      resolved = config
      applyConfig(config)
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return
      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    closeBundle: {
      order: "post",
      sequential: true,
      async handler() {
        if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) return
        await writeCloudflareWranglerConfig({
          outputRoot: createDefaultCloudflareOutputRoot(resolved.root),
          rootDir: resolved.root,
          ...(enabled ? { wranglerConfig: { browser: { binding: resolvedOptions.binding } } } : {}),
          wranglerConfigOwnership: { keys: ["browser"] },
        })
      },
    },
  }
}

declare module "vite" {
  interface UserConfig {
    browser?: BrowserModuleOptions | false
  }
}
