import { isAbsolute, relative, resolve, sep } from "node:path"

import { fetchViteHubDevEndpoint } from "@vite-hub/internal/cli"
import { readWorkspaceDevToken, workspaceDevTokenHeader } from "@vite-hub/workspace/server"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import { agentDevLoopTokenScopeHeader, agentInvocationStreamHeader, agentInvocationStreamHeaderValue } from "../invocation-stream.ts"
import { isRuntimeRecord } from "./runtime-type.ts"

export function isCompatibleAgentDevServerRoot(rootDir: string, serverRoot: string): boolean {
  const nestedPath = relative(resolve(rootDir), resolve(serverRoot))
  return nestedPath === "" || (nestedPath !== ".." && !nestedPath.startsWith(`..${sep}`) && !isAbsolute(nestedPath))
}

async function readToken(discovery: unknown, rootDir: string): Promise<string | undefined> {
  if (!isRuntimeRecord(discovery) || typeof discovery.root !== "string" || typeof discovery.workspaceDevTokenServerId !== "string") return
  if (!isCompatibleAgentDevServerRoot(rootDir, discovery.root)) return
  return await readWorkspaceDevToken(discovery.root, { serverId: discovery.workspaceDevTokenServerId })
}

function parseTokenScope(scope: string): unknown {
  try {
    return JSON.parse(decodeURIComponent(scope))
  }
  catch {
    return undefined
  }
}

export function agentDevLoopDiscoveryFetch(fetchImpl: typeof fetch, rootDir: string): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init)
    const scope = response.headers.get(agentDevLoopTokenScopeHeader)
    if (response.status !== 500 || !scope) return response
    const token = await readToken(parseTokenScope(scope), rootDir)
    if (!token) return response
    await response.body?.cancel().catch(() => undefined)
    const headers = { ...Object.fromEntries(new Headers(init?.headers)), [workspaceDevTokenHeader]: token }
    return await fetchImpl(input, { ...init, headers, redirect: "manual" })
  }
}

/** Reads the Dev Loop token from disk, retrying a failed discovery with the token before reporting the error. */
export async function readAgentDevLoopTokenHeaders(endpoint: string, rootDir: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<Record<string, string>> {
  const response = await fetchViteHubDevEndpoint(agentDevLoopDiscoveryFetch(fetchImpl, rootDir), endpoint, {
    header: agentInvocationStreamHeader,
    headerValue: agentInvocationStreamHeaderValue,
  }, {
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  })
  if (response.status >= 500) {
    const message = (await response.text().catch(() => "")).trim() || "No error details returned."
    throw agentDiagnostics.AGENT_DEV_LOOP_FAILED({ message, status: response.status })
  }
  if (!response.ok) {
    await response.body?.cancel()
    return {}
  }
  const token = await readToken(await response.json().catch(() => undefined), rootDir)
  return token ? { [workspaceDevTokenHeader]: token } : {}
}
