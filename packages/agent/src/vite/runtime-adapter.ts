import { existsSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { createExecutionContext } from "@vite-hub/runtime"

import { agentWithColocatedInstructions } from "../index.ts"
import { createAgentRuntimeContext } from "../runtime/context.ts"
import {
  workspaceAgentWithSourceRoot,
} from "../workspace-agent.ts"
import { hasRuntimeType } from "../internal/runtime-type.ts"
import { decodeColocatedAgentSkills, withColocatedAgentSkills } from "../internal/colocated-agent-skills.ts"
import { readColocatedAgentInstructions } from "./colocated-agent-instructions.ts"
import { readColocatedAgentSkills } from "./colocated-agent-skills.ts"

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
  DefineAgent,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
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

export async function loadViteAgent(
  server: ViteDevServer,
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
  server: ViteDevServer,
  definition: DiscoveredAgentDefinition,
) {
  return async () => {
    const module = await server.ssrLoadModule(pathToFileURL(definition.handler).href)
    // Use the host facade so definitions authored with the primitive package also inherit
    // the Console's configured journal. The facade keeps journal selection lazy and scoped.
    const authored = module.default
    let journalSource = authored
    const invocations = Object.getOwnPropertyDescriptor(authored, "invocations")
    if (server.config.plugins?.some(plugin => plugin.name === "vite-hub/console")) {
      // Nitro runs its plugins in another module runner. Initialize the same generated
      // Console configuration in this runner before resolving its journal fallback.
      // SAFETY: Nitro extends Vite's open config with its registered runtime plugins.
      const nitro = (server.config as typeof server.config & { nitro?: { plugins?: unknown[] } }).nitro
      const bootstrap = nitro?.plugins?.find((plugin): plugin is string =>
        hasRuntimeType(plugin, "string") && /[\\/]\.vitehub[\\/]nitro[\\/]console[\\/]plugin(?:-[^\\/]+)?\.mjs$/.test(plugin))
      if (bootstrap) await server.ssrLoadModule(bootstrap)
      // SAFETY: The active Console plugin belongs to vite-hub, whose Agent facade exports DefineAgent.
      const framework = await server.ssrLoadModule("vite-hub/agent") as { defineAgent: DefineAgent }
      if (!invocations?.get && authored.invocations === undefined) {
        // Only obtain the lazy journal binding; extending authored would rerun preset configuration.
        // The facade requires a valid Driver, but this descriptor carrier is never invoked.
        journalSource = framework.defineAgent({ driver: { run: () => "" }, runtime: false })
      }
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
    // Workspace decoration spreads values and can drop the facade's non-enumerable getter.
    // Keep that binding, including an explicitly authored journal, on the loaded definition.
    for (const key of ["invocations", Symbol.for("vitehub.console.invocations.fallback")]) {
      const descriptor = Object.getOwnPropertyDescriptor(journalSource, key)
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
  for (const [name, value] of response.headers) res.setHeader(name, value)
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
