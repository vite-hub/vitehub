import { existsSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { createExecutionContext } from "@vite-hub/runtime"

import { agentWithColocatedInstructions } from "../index.ts"
import { agentInvocationsFallbackKey } from "../invocations/app.ts"
import { createAgentRuntimeContext } from "../runtime/context.ts"
import {
  workspaceAgentWithSourceRoot,
} from "../workspace-agent.ts"
import { decodeColocatedAgentSkills, withColocatedAgentSkills } from "../internal/colocated-agent-skills.ts"
import { readColocatedAgentInstructions } from "./colocated-agent-instructions.ts"
import { readColocatedAgentSkills } from "./colocated-agent-skills.ts"
import { devModuleRunners } from "./dev-module-runners.ts"
import { setViteHubDevResponseHeaders } from "@vite-hub/internal/dev-endpoint"
import { isRecord } from "@vite-hub/internal/object"
import { normalizePath } from "vite"
import { ESModulesEvaluator, ModuleRunner } from "vite/module-runner"

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http"
import type { ViteDevServer } from "vite"
import type {
  AgentHostIdentity,
  AgentInput,
  AgentRunMetadata,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  ResolvedAgentRuntimeContext,
  DiscoveredAgentDefinition,
} from "../index.ts"

export interface ViteAgentRuntimeContext extends ResolvedAgentRuntimeContext {
  request?: Request
  runtime: "vite"
  runtimeConfig: AgentRuntimeConfig
}

interface LoadedViteAgent {
  agent: AgentInput<ViteAgentRuntimeContext>
  definition: DiscoveredAgentDefinition
  identity: AgentHostIdentity
}

function resolveAgentModule(module: unknown): AgentInput<ViteAgentRuntimeContext> | undefined {
  if (isRecord(module) && "default" in module) {
    return module.default as AgentInput<ViteAgentRuntimeContext> | undefined
  }
  return module as AgentInput<ViteAgentRuntimeContext> | undefined
}

function workspaceSourceRoot(file: string): string {
  const workspaceDirectory = join(dirname(file), "workspace")
  return existsSync(workspaceDirectory) && statSync(workspaceDirectory).isDirectory()
    ? workspaceDirectory
    : dirname(file)
}

function colocatedSkills(file: string) {
  return decodeColocatedAgentSkills(readColocatedAgentSkills(file))
}

/** The part of a Vite dev server that loads an Agent module. */
export type ViteAgentModuleServer = Pick<ViteDevServer, "config" | "ssrLoadModule"> & Partial<Pick<ViteDevServer, "environments" | "watcher">>

/**
 * Imports a module in this process. Vite runs it in the `ssr` environment. Nuxt 5 gives that environment to the Vue
 * renderer in Nitro's worker, so `ssrLoadModule()` throws there. ViteHub then runs the module with its own module runner,
 * through the `nitro` environment that owns server code. Other environments send `nitro/*` imports to the worker.
 */
export async function importViteDevModule(server: ViteAgentModuleServer, url: string): ReturnType<ViteDevServer["ssrLoadModule"]> {
  const ssr = server.environments?.ssr
  // Vite's `isRunnableDevEnvironment()` is an `instanceof` check. It fails when the app and ViteHub load different Vite copies.
  if (!ssr || "runner" in ssr) return await server.ssrLoadModule(url)
  const environment = server.environments?.nitro ?? ssr
  let runner = devModuleRunners.get(environment)?.runner
  if (!runner) {
    const created = new ModuleRunner({
      hmr: false,
      sourcemapInterceptor: "prepareStackTrace",
      transport: { invoke: payload => environment.hot.handleInvoke(payload) },
    }, new ESModulesEvaluator())
    // Nitro's worker shares the module graph and can transform an edited file first, so the graph alone does not tell
    // this runner that the file changed. Drop the modules that it ran, as Vite's SSR runner does on a full reload.
    const drop = (file: string) => {
      if (created.evaluatedModules.getModulesByFile(normalizePath(file))?.size) created.clearCache()
    }
    server.watcher?.on("change", drop)
    server.watcher?.on("unlink", drop)
    devModuleRunners.set(environment, {
      close: async () => {
        server.watcher?.off("change", drop)
        server.watcher?.off("unlink", drop)
        await created.close()
      },
      runner: created,
    })
    runner = created
  }
  return await runner.import(url)
}

export async function loadViteAgent(
  server: ViteAgentModuleServer,
  definition: DiscoveredAgentDefinition,
): Promise<LoadedViteAgent | undefined> {
  const module = await createViteWorkspaceAgentLoader(server, definition)()
  const agent = resolveAgentModule(module)
  if (!agent) return
  return {
    agent,
    definition,
    identity: {
      name: definition.name,
      ...(definition.workspace ? { workspace: definition.workspace } : {}),
    },
  }
}

export function createViteWorkspaceAgentLoader(
  server: ViteAgentModuleServer,
  definition: DiscoveredAgentDefinition,
) {
  return async () => {
    const module = await importViteDevModule(server, pathToFileURL(definition.handler).href)
    // defineAgent() keeps the journal lazy, so the definition reads the app-wide journal that the generated plugin installs.
    const authored = module.default
    const hostPlugins = server.config.plugins ?? []
    const usesJournal = hostPlugins.some(plugin => plugin.name === "vite-hub/agent-invocations")
    const usesConsole = hostPlugins.some(plugin => plugin.name === "vite-hub/console")
    if (usesJournal || usesConsole) {
      // Nitro runs its plugins in another module runner. Initialize the same generated
      // journal and Console configuration in this runner before resolving the journal.
      // SAFETY: Nitro extends Vite's open config with its registered runtime plugins.
      const nitro = (server.config as typeof server.config & { nitro?: { plugins?: unknown[] } }).nitro
      const generated = (pattern: RegExp) => nitro?.plugins?.find((plugin): plugin is string => typeof plugin === "string" && pattern.test(plugin))
      const journal = usesJournal ? generated(/[\\/]\.vitehub[\\/]nitro[\\/]agent[\\/]invocations\.mjs$/) : undefined
      const bootstrap = usesConsole ? generated(/[\\/]\.vitehub[\\/]nitro[\\/]console[\\/]plugin(?:-[^\\/]+)?\.mjs$/) : undefined
      if (journal) await importViteDevModule(server, journal)
      if (bootstrap) await importViteDevModule(server, bootstrap)
    }
    const colocatedInstructions = await readColocatedAgentInstructions(definition.handler)
    const agent = workspaceAgentWithSourceRoot(
      withColocatedAgentSkills(
        agentWithColocatedInstructions(authored, colocatedInstructions),
        colocatedSkills(definition.handler),
      ),
      workspaceSourceRoot(definition.handler),
      colocatedInstructions,
    )
    // Workspace decoration spreads values and can drop the non-enumerable journal getter.
    // Keep that binding, including an explicitly authored journal, on the loaded definition.
    for (const key of ["invocations", agentInvocationsFallbackKey]) {
      const descriptor = Object.getOwnPropertyDescriptor(authored, key)
      if (descriptor) Object.defineProperty(agent, key, descriptor)
    }
    return {
      ...module,
      default: agent,
    }
  }
}

function headersFromNode(headers: IncomingHttpHeaders): Headers {
  const result = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result.set(name, value)
    else if (Array.isArray(value)) {
      for (const item of value) result.append(name, item)
    }
  }
  return result
}

function createRequest(server: ViteDevServer, req: IncomingMessage, fallbackRoute: string): Request {
  const base = server.resolvedUrls?.local?.[0] || `http://localhost:${server.config.server.port || 5173}/`
  return new Request(new URL(req.url || fallbackRoute, base), {
    headers: headersFromNode(req.headers),
    method: req.method || "GET",
  })
}

export function createViteAgentRuntimeContext(
  server: ViteDevServer,
  req: IncomingMessage,
  identity: AgentHostIdentity,
  options: { capabilities?: AgentRuntimeContext["capabilities"], fallbackRoute: string, run?: AgentRunMetadata },
): ViteAgentRuntimeContext {
  // SAFETY: This adapter fixes the runtime to Vite and supplies its runtime configuration before normalization.
  const context = createAgentRuntimeContext({
    agentIdentity: identity,
    request: createRequest(server, req, options.fallbackRoute),
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    ...(options.run ? { run: options.run } : {}),
    runtime: "vite",
    runtimeConfig: {},
    waitUntil: task => void Promise.resolve(task).catch(() => {}),
  }) as AgentRuntimeContext & { runtime: "vite", runtimeConfig: AgentRuntimeConfig }
  return createExecutionContext(context)
}

export function createViteAgentDiscoveryContext(identity: AgentHostIdentity): ViteAgentRuntimeContext {
  // SAFETY: Discovery runs only in Vite and supplies its runtime configuration before normalization.
  const context = createAgentRuntimeContext({
    agentIdentity: identity,
    runtime: "vite",
    runtimeConfig: {},
    waitUntil: task => void Promise.resolve(task).catch(() => {}),
  }) as AgentRuntimeContext & { runtime: "vite", runtimeConfig: AgentRuntimeConfig }
  return createExecutionContext(context)
}

export async function writeViteResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  setViteHubDevResponseHeaders(res, response.headers)
  if (!response.body) {
    res.end()
    return
  }

  const reader = response.body.getReader()
  let closed = false
  const cancel = () => {
    if (closed) return
    closed = true
    Promise.resolve().then(() => reader.cancel()).catch(() => {})
  }
  res.once("close", cancel)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
    closed = true
    res.end()
  }
  catch (error) {
    const wasClosed = closed
    closed = true
    if (wasClosed && error instanceof Error && error.name === "AbortError") return
    res.destroy(error instanceof Error ? error : undefined)
  }
  finally {
    closed = true
    res.off("close", cancel)
    reader.releaseLock()
  }
}
