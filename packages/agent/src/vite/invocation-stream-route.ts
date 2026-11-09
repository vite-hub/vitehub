import { registerViteHubDevEndpoint } from "@vite-hub/internal/dev-endpoint"
import { refreshWorkspaceDevToken, validateWorkspaceDevToken, workspaceDevTokenServerId } from "@vite-hub/workspace/server"

import { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } from "../invocation-stream.ts"

import type { IncomingMessage } from "node:http"
import type { ViteDevServer } from "vite"

export interface AgentDevRuntimeCapability {
  importName: string
  name: string
  packageName: false | string
}

export interface AgentDevRuntimeOptions {
  runtimeCapabilities?: AgentDevRuntimeCapability[]
}

export function isAgentDevLoopDiscoveryRequest(req: IncomingMessage): boolean {
  return req.method === "GET" && new URL(req.url || "/", "http://localhost").searchParams.get("inspect") !== "1"
}

/** Registers the Dev Loop endpoint. The Agent runtime that answers it loads on the first request, not when the dev server starts. */
export async function registerAgentInvocationStreamEndpoint(server: ViteDevServer, runtimeOptions: AgentDevRuntimeOptions = {}): Promise<void> {
  const tokenOptions = { serverId: workspaceDevTokenServerId(server.config.server.port) }
  await refreshWorkspaceDevToken(server.config.root, tokenOptions)
  registerViteHubDevEndpoint(server, {
    // Inspection, streams, Capability CLI calls, Workspace commands, and Channel replay run Agent code or return Agent data.
    authorize: async req => isAgentDevLoopDiscoveryRequest(req) || await validateWorkspaceDevToken(server.config.root, req.headers, tokenOptions)
      ? undefined
      : new Response("Forbidden Agent Dev Loop token.", { status: 403 }),
    handle: (req, res, grant) => {
      void import("./invocation-stream-endpoint.ts").then(({ handleAgentInvocationStreamEndpoint }) =>
        handleAgentInvocationStreamEndpoint(server, req, res, grant, tokenOptions, runtimeOptions))
    },
    header: agentInvocationStreamHeader,
    headerValue: agentInvocationStreamHeaderValue,
    label: "Agent Dev Loop",
    methods: ["GET", "POST"],
    route: agentInvocationStreamRoute,
  })
}
