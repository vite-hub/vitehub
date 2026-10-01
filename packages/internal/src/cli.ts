import { isPlainObject } from "./object.ts"

import type { ProvisionStep } from "./provision.ts"

export interface ViteHubCliStreams {
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

export interface ViteHubCliSpawnResult {
  exitCode: number | null
  signal?: NodeJS.Signals | null
}

export interface ViteHubCliSpawnOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stderr?: "inherit" | "pipe"
  stdout?: "inherit" | "pipe"
}

export type ViteHubCliSpawn = (
  command: string,
  args: string[],
  options?: ViteHubCliSpawnOptions,
) => Promise<ViteHubCliSpawnResult>

export interface ViteHubCliContext extends ViteHubCliStreams {
  cwd: string
  env: NodeJS.ProcessEnv
  rootDir: string
  spawn: ViteHubCliSpawn
}

export interface ViteHubCliFeature {
  description?: string
  name: string
  run: (args: string[], context: ViteHubCliContext) => Promise<number | void> | number | void
  usage?: string
}

export interface ViteHubCliCommandNamespace {
  description?: string
  features: ViteHubCliFeature[]
  name: string
}

export interface ViteHubCliContributor {
  namespaces: ViteHubCliCommandNamespace[]
  provision?: ProvisionStep[]
}

export type ViteHubCliContributorFactory = () => ViteHubCliContributor | undefined | Promise<ViteHubCliContributor | undefined>

export interface ViteHubCliPluginMetadata {
  cli?: ViteHubCliContributor | ViteHubCliContributorFactory
}

export interface ViteHubCliContributingPlugin {
  vitehub?: ViteHubCliPluginMetadata
}

async function resolveContributor(value: ViteHubCliPluginMetadata["cli"]): Promise<ViteHubCliContributor | undefined> {
  return typeof value === "function" ? await value() : value
}

export async function collectViteHubCliNamespaces(plugins: readonly unknown[]): Promise<ViteHubCliCommandNamespace[]> {
  const namespaces = new Map<string, ViteHubCliCommandNamespace>()

  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== "object") continue
    const metadata = (plugin as ViteHubCliContributingPlugin).vitehub
    const contributor = await resolveContributor(metadata?.cli)
    if (!contributor) continue

    for (const namespace of contributor.namespaces) {
      const existing = namespaces.get(namespace.name)
      if (!existing) {
        namespaces.set(namespace.name, { ...namespace, features: [...namespace.features] })
        continue
      }

      const features = new Map(existing.features.map(feature => [feature.name, feature]))
      for (const feature of namespace.features) {
        features.set(feature.name, feature)
      }
      existing.features = [...features.values()]
    }
  }

  return [...namespaces.values()]
}

export async function collectViteHubProvisionSteps(plugins: readonly unknown[]): Promise<ProvisionStep[]> {
  const steps = new Map<string, ProvisionStep>()

  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== "object") continue
    const contributor = await resolveContributor((plugin as ViteHubCliContributingPlugin).vitehub?.cli)
    for (const step of contributor?.provision ?? []) {
      steps.set(step.id, step)
    }
  }

  return [...steps.values()]
}

/**
 * Environment variable that sets the default Compatible Vite Development Server URL for runtime commands.
 */
export const viteHubDevServerUrlEnv = "VITEHUB_DEV_SERVER_URL"

/**
 * Default Compatible Vite Development Server URL when neither `--url` nor `VITEHUB_DEV_SERVER_URL` is set.
 */
export const defaultViteHubDevServerUrl = "http://localhost:5173"

/**
 * Dev server target options that runtime commands share.
 *
 * The target is always a local Vite Development Server. Dev endpoints trust
 * the guard header, the request origin, and a token file under the project
 * root. A deployed stage has none of these, so this helper is dev-only.
 */
export interface ViteHubDevTargetArgs {
  timeout?: number
  url: string
}

/**
 * Error factories for dev target option parsing. Each owner package passes
 * its own diagnostics, so error codes stay owned by the command.
 */
export interface ViteHubDevTargetOptionErrors {
  invalidInlineTimeout: (message: string) => Error
  invalidTimeout: (message: string) => Error
  missingValue: (message: string) => Error
}

/**
 * Guarded dev endpoint that a runtime command calls.
 */
export interface ViteHubDevEndpoint {
  header: string
  headerValue: string
  route: string
}

export interface ViteHubDevServerDiscoveryOptions {
  endpoint: ViteHubDevEndpoint
  fetch: typeof fetch
  /**
   * Checks the root that the dev server reports. Defaults to exact equality with `rootDir`.
   */
  isCompatibleRoot?: (rootDir: string, serverRoot: string) => boolean
  rootDir: string
  serverUrl: string
  stderr: ViteHubCliStreams["stderr"]
}

export interface ViteHubDevServerTarget<TDiscovery> {
  discovery: TDiscovery
  /** Absolute URL of the guarded dev endpoint. */
  url: string
}

export function resolveViteHubDevServerUrl(env: NodeJS.ProcessEnv): string {
  return env[viteHubDevServerUrlEnv] || defaultViteHubDevServerUrl
}

function parseViteHubDevTimeout(value: string, error: (message: string) => Error): number {
  const timeout = Number.parseInt(value, 10)
  if (!Number.isFinite(timeout) || timeout <= 0) throw error("--timeout must be a positive number.")
  return timeout
}

/**
 * Reads one dev target option at `args[index]`: `--url <url>`, `--server <url>`,
 * `--url=<url>`, `--timeout <ms>` or `--timeout=<ms>`.
 *
 * Returns the number of extra arguments that the option used (`0` or `1`), or
 * `undefined` when `args[index]` is not a dev target option.
 */
export function readViteHubDevTargetOption(
  args: readonly string[],
  index: number,
  target: ViteHubDevTargetArgs,
  errors: ViteHubDevTargetOptionErrors,
): 0 | 1 | undefined {
  const arg = args[index]
  if (arg === undefined) return
  const readValue = () => {
    const value = args[index + 1]
    if (!value || value.startsWith("-")) throw errors.missingValue(`Missing value for ${arg}.`)
    return value
  }
  if (arg === "--url" || arg === "--server") {
    target.url = readValue()
    return 1
  }
  if (arg.startsWith("--url=")) {
    target.url = arg.slice("--url=".length)
    return 0
  }
  if (arg === "--timeout") {
    target.timeout = parseViteHubDevTimeout(readValue(), errors.invalidTimeout)
    return 1
  }
  if (arg.startsWith("--timeout=")) {
    target.timeout = parseViteHubDevTimeout(arg.slice("--timeout=".length), errors.invalidInlineTimeout)
    return 0
  }
}

/**
 * Resolves a dev endpoint route against the dev server URL. Throws when the URL is not valid.
 */
export function viteHubDevEndpointUrl(serverUrl: string, route: string): string {
  return new URL(route, serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`).href
}

/**
 * Calls a guarded dev endpoint. Adds the endpoint guard header to `init.headers`.
 */
export async function fetchViteHubDevEndpoint(
  fetchImpl: typeof fetch,
  url: string,
  endpoint: Pick<ViteHubDevEndpoint, "header" | "headerValue">,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
): Promise<Response> {
  return await fetchImpl(url, {
    ...init,
    headers: {
      ...init.headers,
      [endpoint.header]: endpoint.headerValue,
    },
  })
}

/**
 * Finds a Compatible Vite Development Server through the discovery `GET` of a guarded dev endpoint.
 *
 * Writes the reason to `stderr` and returns `undefined` when the URL is not
 * valid, the server does not answer, or the server root does not match.
 */
export function discoverViteHubDevServer(options: ViteHubDevServerDiscoveryOptions): Promise<ViteHubDevServerTarget<Record<string, unknown>> | undefined>
export function discoverViteHubDevServer<TDiscovery extends { root?: unknown }>(
  options: ViteHubDevServerDiscoveryOptions & { parseDiscovery: (value: unknown) => TDiscovery },
): Promise<ViteHubDevServerTarget<TDiscovery> | undefined>
export async function discoverViteHubDevServer(
  options: ViteHubDevServerDiscoveryOptions & { parseDiscovery?: (value: unknown) => { root?: unknown } },
): Promise<ViteHubDevServerTarget<{ root?: unknown }> | undefined> {
  let url: string
  try {
    url = viteHubDevEndpointUrl(options.serverUrl, options.endpoint.route)
  }
  catch {
    options.stderr.write(`Invalid Vite Development Server URL: ${options.serverUrl}\n`)
    return
  }
  let response: Response
  try {
    response = await fetchViteHubDevEndpoint(options.fetch, url, options.endpoint, {
      headers: { accept: "application/json" },
    })
  }
  catch {
    options.stderr.write(`No Compatible Vite Development Server found at ${options.serverUrl}.\n`)
    return
  }
  if (!response.ok) {
    options.stderr.write(`No Compatible Vite Development Server found at ${options.serverUrl}.\n`)
    return
  }
  const value: unknown = await response.json().catch(() => undefined)
  const discovery = options.parseDiscovery ? options.parseDiscovery(value) : isPlainObject(value) ? value : {}
  const isCompatibleRoot = options.isCompatibleRoot ?? ((rootDir: string, serverRoot: string) => serverRoot === rootDir)
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate the untrusted discovery root before comparing it with the local project.
  if (typeof discovery.root === "string" && !isCompatibleRoot(options.rootDir, discovery.root)) {
    options.stderr.write(`Compatible Vite Development Server root mismatch: ${discovery.root}\n`)
    return
  }
  return { discovery, url }
}
