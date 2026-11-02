import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, extname, join, resolve } from "node:path"
import { parseJSONC, parseTOML } from "confbox"

const wranglerConfigFiles = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** The project's wrangler config, found the way Nitro's Cloudflare preset finds it: the nearest file from `rootDir` up. */
export function readProjectWranglerConfig(rootDir: string): Record<string, unknown> | undefined {
  let directory = resolve(rootDir)
  while (true) {
    const configPath = wranglerConfigFiles.map(file => join(directory, file)).find(file => existsSync(file) && statSync(file).isFile())
    if (configPath) {
      const text = readFileSync(configPath, "utf8")
      const extension = extname(configPath)
      const config: unknown = extension === ".toml" ? parseTOML(text) : extension === ".jsonc" ? parseJSONC(text) : JSON.parse(text)
      return isRecord(config) ? config : undefined
    }
    const parent = dirname(directory)
    if (parent === directory) return
    directory = parent
  }
}

function setsRouting(config: Record<string, unknown> | undefined): boolean {
  return config !== undefined && ["route", "routes", "workers_dev"].some(key => config[key] !== undefined)
}

/**
 * The wrangler keys that serve the Worker on the custom domain of `publicUrl`: one `custom_domain` route and
 * `workers_dev: false`. Returns nothing for a workers.dev origin, an HTTP origin, or an origin with a port. Also returns
 * nothing when the app's Nitro wrangler config or project wrangler file sets `route`, `routes`, or `workers_dev`: Nitro
 * merges these keys with the project file, so ViteHub leaves routing to the app as soon as the app sets one of them.
 */
export function cloudflareCustomDomainConfig(
  publicUrl: string,
  wrangler: Record<string, unknown>,
  project: Record<string, unknown> | undefined,
): { routes: [{ custom_domain: true, pattern: string }], workers_dev: false } | undefined {
  const url = new URL(publicUrl)
  if (url.protocol !== "https:" || url.port || url.hostname.endsWith(".workers.dev")) return
  if (setsRouting(wrangler) || setsRouting(project)) return
  return { routes: [{ custom_domain: true, pattern: url.hostname }], workers_dev: false }
}
