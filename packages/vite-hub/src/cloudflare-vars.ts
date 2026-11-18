import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { EnvRuntimeRegistry } from "@vite-hub/env"
import { isRecord } from "@vite-hub/internal/object"

interface CloudflareServerEnvVar {
  names: string[]
  name: string
  value: string
}

/**
 * The Worker `vars` for `cloudflare: { vars: true }`: each non-secret Server Env value read from a host variable, under
 * the name that holds it in `env`, the build environment. A name is tried in the order Server Env reads it at runtime.
 * Secrets, literals, providers, and values that are missing or empty stay out, so a default still applies at runtime.
 */
export function cloudflareServerEnvVars(registry: EnvRuntimeRegistry, env: Record<string, string | undefined>): CloudflareServerEnvVar[] {
  const vars: CloudflareServerEnvVar[] = []
  const secretNames = new Set<string>()
  const visit = (value: unknown): void => {
    if (!isRecord(value) || value.kind === "literal") return
    const source = value.source
    if (isRecord(source) && typeof value.secret === "boolean" && typeof value.required === "boolean") {
      if (source.kind !== "env") return
      const names = (Array.isArray(source.names) ? source.names : [source.name]).filter((name): name is string => typeof name === "string")
      if (value.secret) {
        for (const name of names) secretNames.add(name)
        return
      }
      const name = names.find(name => Object.hasOwn(env, name) && Boolean(env[name]))
      if (name) vars.push({ names, name, value: env[name]! })
      return
    }
    for (const child of Object.values(value)) visit(child)
  }
  visit(registry)
  return vars.filter(({ name }) => !secretNames.has(name))
}

/**
 * Adds `vars` to the generated `wrangler.json` in `serverDir`, at the top level and in each `env`, since named
 * environments do not inherit vars. A var that the Wrangler config already sets keeps its value. Nitro writes no file
 * with `cloudflare.deployConfig: false`, and then there is nothing to add to.
 */
export async function addCloudflareVars(serverDir: string, vars: CloudflareServerEnvVar[]): Promise<void> {
  if (!vars.length) return
  const file = resolve(serverDir, "wrangler.json")
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return
  const wrangler: unknown = JSON.parse(text)
  if (!isRecord(wrangler)) return
  const withVars = (target: Record<string, unknown>): Record<string, unknown> => {
    const explicit = isRecord(target.vars) ? target.vars : {}
    // An explicit fallback must not be shadowed by an automatic canonical name.
    const additions = vars.filter(({ names }) => !names.some(name => Object.hasOwn(explicit, name) && explicit[name] !== undefined && explicit[name] !== ""))
    return { ...target, vars: { ...Object.fromEntries(additions.map(({ name, value }) => [name, value])), ...explicit } }
  }
  const result = withVars(wrangler)
  if (isRecord(wrangler.env)) {
    result.env = Object.fromEntries(Object.entries(wrangler.env).map(([name, config]) => [name, isRecord(config) ? withVars(config) : config]))
  }
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`)
}
