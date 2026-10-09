import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { getHostingProvider } from "@vite-hub/internal/hosting"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT } from "@vite-hub/internal/build/vite"

import type { EnvVariableDeclaration } from "@vite-hub/env"
import type { Plugin } from "vite"

import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"

/** Self-contained options for the evlog Nitro module. */
export interface ObservabilityEvlogOptions {
  enabled?: boolean
  pretty?: boolean
  silent?: boolean
  env?: Partial<Record<"service" | "environment" | "version" | "commitHash" | "region", string>>
  include?: string[]
  exclude?: string[]
  routes?: Record<string, { service: string }>
  minLevel?: "debug" | "info" | "warn" | "error"
  dev?: "evlog" | "nitro" | "both" | {
    frameworkOverlay?: boolean
    prettyError?: { snippet?: boolean, stackDepth?: number, compact?: boolean, detail?: "full" | "guidance" }
  }
  sampling?: {
    rates?: Partial<Record<"debug" | "info" | "warn" | "error", number>>
    keep?: Array<{ status?: number, duration?: number, path?: string }>
  }
  redact?: boolean | {
    paths?: string[]
    patterns?: RegExp[]
    builtins?: false | Array<"creditCard" | "email" | "ipv4" | "phone" | "jwt" | "bearer" | "iban">
    replacement?: string | ((matched: unknown, context: { path: string, key: string, groups?: Array<string | undefined> }) => string)
    transform?: (event: Record<string, unknown> & {
      timestamp: string
      level: "debug" | "info" | "warn" | "error"
      service: string
      environment: string
      version?: string
      commitHash?: string
      region?: string
      duration?: string
      durationMs?: number
    }) => void
  }
}

export interface ObservabilityOptions {
  /** Service name on every event and log. */
  service: string
  /** Defaults to `NODE_ENV`, then `development`. */
  environment?: string
  /** Export events, exceptions, and failed request logs to PostHog. */
  posthog?: {
    /** Server Env reference, for example `env({ secret: true, source: env.source("POSTHOG_API_KEY") })`. */
    apiKey: EnvVariableDeclaration | string
    /** Defaults to `https://us.i.posthog.com`. */
    host?: string
  }
  /** Options for the evlog Nitro module, such as `sampling`, `redact`, and `pretty`. */
  evlog?: ObservabilityEvlogOptions
  /** Durable papercut reports, backed by the Console invocation journal. */
  papercuts?: true | { eventPrefix?: string, uuidNamespace?: string, intervalMs?: number }
  /** Queue bound for best-effort events and for the log buffer. Defaults to 1,000. */
  maxPending?: number
}

const generatedObservabilityPlugin = ".vitehub/nitro/observability/plugin.mjs"

function renderObservabilityNitroPlugin(options: ObservabilityOptions): string {
  const papercuts = options.papercuts === true ? {} : options.papercuts
  // JSON.stringify drops unset values.
  const settings = { service: options.service, environment: options.environment, maxPending: options.maxPending }
  const posthog = options.posthog ? { host: options.posthog.host, service: options.service } : undefined
  return [
    `import { installObservability } from "@vite-hub/agent/observability/host"`,
    ...(posthog
      ? [
          `import { posthog } from "@vite-hub/agent/observability/posthog"`,
          `import { loadServerEnv } from "#vitehub/env/server"`,
        ]
      : []),
    ...(papercuts ? [`import { getConsoleInvocations } from "vite-hub/console/server"`] : []),
    "",
    "export default async function viteHubObservabilityPlugin(nitroApp) {",
    ...(posthog
      ? [
          "  const serverEnv = await loadServerEnv()",
          "  const apiKey = serverEnv.observability?.posthog?.apiKey",
          "  const key = typeof apiKey?.unseal === \"function\" ? apiKey.unseal() : apiKey",
        ]
      : []),
    "  installObservability({",
    `    ...${JSON.stringify(settings)},`,
    ...(posthog ? [`    ...(key ? { exporter: posthog({ ...${JSON.stringify(posthog)}, apiKey: key }) } : {}),`] : []),
    ...(papercuts ? [`    papercuts: { ...${JSON.stringify(papercuts)}, invocations: getConsoleInvocations },`] : []),
    "  })(nitroApp)",
    "}",
    "",
  ].join("\n")
}

async function writeIfChanged(file: string, contents: string): Promise<void> {
  if (await readFile(file, "utf8").catch(() => undefined) === contents) return
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, contents, "utf8")
}

/** Register the evlog Nitro module and a generated plugin that installs `useObservability()`. */
export function observabilityVitePlugin(options: ObservabilityOptions, target: {
  agent?: boolean | { runtime?: string }
  hosting?: string
} = {}): Plugin {
  if (!options.service?.trim()) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0125({ message: "[vitehub] observability requires a non-empty service name." })
  }
  const normalizedOptions = {
    ...options,
    service: options.service.trim(),
    environment: options.environment?.trim() || options.evlog?.env?.environment?.trim() || process.env.NODE_ENV || "development",
  }
  return {
    name: "vite-hub/observability",
    configResolved(config) {
      // SAFETY: ViteHub and Agent plugins extend these public Vite config keys.
      const resolved = config as typeof config & {
        agent?: boolean | { runtime?: string }
        vitehub?: { preset?: string }
        preset?: string
        nitro?: { preset?: string }
      }
      const agent = resolved.agent ?? target.agent
      const hosting = [resolved.vitehub?.preset, resolved.preset, resolved.nitro?.preset, target.hosting, process.env.VITEHUB_HOSTING]
        .map(preset => getHostingProvider(preset)).find(Boolean)
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Vite config may contain a Boolean shorthand or an Agent options object.
      if (agent && ((typeof agent === "object" && agent.runtime === "deno") || hosting === "netlify")) {
        throw viteHubErrorDiagnostics.VITE_HUB_R0129({ message: "[vitehub] observability currently requires Nitro-hosted Agents. Netlify and Deno Agent output are not supported." })
      }
    },
    async config(config) {
      const { default: evlog } = await import("evlog/nitro/v3").catch(() => {
        throw viteHubErrorDiagnostics.VITE_HUB_B0012({ message: "[vitehub] vitehub({ observability }) requires the evlog package. Install evlog." })
      })
      // SAFETY: ViteHub Env and Nitro extend Vite's user config with these documented top-level keys.
      const viteConfig = config as typeof config & {
        [VITEHUB_PROJECT_ROOT]?: string
        env?: { server?: Record<string, unknown> }
        nitro?: Record<string, unknown>
      }
      if (options.posthog) {
        const env = viteConfig.env ??= {}
        const server = env.server ??= {}
        // SAFETY: A previous run of this hook on the same config object wrote this shape.
        if (server.observability !== undefined && (server.observability as { posthog?: { apiKey?: unknown } }).posthog?.apiKey !== options.posthog.apiKey) {
          throw viteHubErrorDiagnostics.VITE_HUB_R0128({ message: "[vitehub] env.server.observability is reserved for vitehub({ observability })." })
        }
        server.observability = { posthog: { apiKey: options.posthog.apiKey } }
      }
      // SAFETY: ViteHub's project-root config value is an externally supplied Vite extension key.
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Narrow the optional extension value before resolving its path.
      const projectRoot = typeof viteConfig[VITEHUB_PROJECT_ROOT] === "string"
        ? resolve(viteConfig[VITEHUB_PROJECT_ROOT])
        : resolveViteHubProjectRoot(config.root || process.cwd())
      const plugin = resolve(projectRoot, generatedObservabilityPlugin)
      await writeIfChanged(plugin, renderObservabilityNitroPlugin(normalizedOptions))
      const kit = createNitroServerKit(viteConfig.nitro)
      kit.addPlugin(plugin)
      const modules = Array.isArray(kit.config.modules) ? kit.config.modules : []
      const evlogOptions = options.evlog ?? {}
      const env: NonNullable<ObservabilityEvlogOptions["env"]> = { ...evlogOptions.env, service: normalizedOptions.service }
      env.environment = normalizedOptions.environment
      // One evlog module per Nitro app. Skip it when this hook already ran on the same config.
      if (!modules.some(module => module instanceof Object && "name" in module && module.name === "evlog")) {
        kit.config.modules = [...modules, evlog({ ...evlogOptions, env })]
      }
      viteConfig.nitro = kit.config
    },
  }
}
