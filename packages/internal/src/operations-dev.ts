import { validateViteHubNitroDevRequest } from "./dev-endpoint.ts"
import { isViteHubLoopbackPeer } from "./dev-peer.ts"
import { internalErrorDiagnostics } from "./error-diagnostics.ts"
import { answerOperationRpc, operationRpcRefusal, readOperationRpcCall } from "./operation-rpc.ts"
import { assertOperationProject, createOperationRegistry, operationRootHeader, operationRpcHeader, operationsOf, projectRootHash, runOperation, toOperationFailure } from "./operations.ts"

import type { OperationContext } from "./operations.ts"

function readPath(value: unknown, ...path: string[]): unknown {
  for (const key of path) value = value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined
  return value
}

/** The Cloudflare bindings of a Request: from the Standard Context that Nitro sets, else where srvx puts them. */
function requestEnv(request: Request): Record<string, unknown> | undefined {
  const env = readPath(request, "~standard", "runtime", "cloudflare", "env") ?? readPath(request, "runtime", "cloudflare", "env")
  // SAFETY: Nitro and srvx store the Worker bindings as an object under `runtime.cloudflare.env`.
  return env !== null && typeof env === "object" ? env as Record<string, unknown> : undefined
}

/** The `waitUntil` of a Request: from its Standard Context, else from the Request or its Worker ExecutionContext. */
function requestWaitUntil(request: Request): ((task: Promise<unknown>) => void) | undefined {
  for (const owner of [readPath(request, "~standard"), request, readPath(request, "runtime", "cloudflare", "context")]) {
    const waitUntil = readPath(owner, "waitUntil")
    // SAFETY: Hosts expose waitUntil(promise) on the Standard Context, the Request, or the ExecutionContext.
    if (typeof waitUntil === "function") return (waitUntil as (task: Promise<unknown>) => void).bind(owner)
  }
  return undefined
}

function localHost(host: string): boolean {
  try {
    const name = new URL(`http://${host}`).hostname
    return name === "localhost" || name.endsWith(".localhost") || name === "127.0.0.1" || name === "[::1]"
  }
  catch { return false }
}

function reject(status: number, message: string): never {
  throw Object.assign(new Error(message), { code: "OPERATION_DEV_REQUEST", status })
}

/**
 * Bundled into owner packages and used only by their serve-only generated Nitro route. Operations get the Request as
 * `context.event`, so owner hooks such as `identify` of Comments read its Standard Context.
 */
export function createStandaloneOperationHandler(sources: { operations: unknown, plugin: string }[], root: string): { fetch(request: Request): Promise<Response> } {
  const registry = createOperationRegistry(sources.map(source => ({ ...source, operations: operationsOf(source.operations) })))
  const defaultLimit = 64 * 1_024
  const maximum = Math.max(defaultLimit, ...registry.list().map(operation => operation.maxRequestBytes ?? defaultLimit))
  const operations = Object.fromEntries(registry.list().map(operation => [operation.name, operation]))
  return {
    async fetch(request) {
      const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", [operationRootHeader]: projectRootHash(root) }
      try {
        const address = [readPath(request, "ip"), readPath(request, "context", "clientAddress"), readPath(request, "runtime", "node", "req", "socket", "remoteAddress")].find((value): value is string => typeof value === "string" && value !== "")
        const forwarded = request.headers.get("x-forwarded-host")
        if (!localHost(request.headers.get("host") ?? new URL(request.url).host) || (forwarded && !localHost(forwarded)) || !await isViteHubLoopbackPeer(request, address)) reject(403, "Standalone development operations accept only local requests.")
        const site = request.headers.get("sec-fetch-site")
        if (site === "cross-site" || site === "same-site") reject(403, "Cross-origin operation requests are not allowed.")
        const checked = await validateViteHubNitroDevRequest(request, { header: operationRpcHeader, headerValue: "1", label: "Operation RPC" })
        if (checked.rejection) reject(checked.rejection.status, await checked.rejection.text())
        assertOperationProject(request, root)
        const reader = request.body?.getReader()
        const decoder = new TextDecoder()
        let text = ""
        let bytes = 0
        try {
          if (reader) while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            bytes += chunk.value.byteLength
            if (bytes > maximum) reject(413, "Operation request exceeds the byte limit.")
            text += decoder.decode(chunk.value, { stream: true })
          }
          text += decoder.decode()
        }
        catch (error) {
          await reader?.cancel()
          throw error
        }
        finally { reader?.releaseLock() }
        let payload: unknown
        try { payload = JSON.parse(text) }
        catch { reject(400, "Malformed operation request.") }
        const call = readOperationRpcCall(payload)
        if (!call) reject(400, "Invalid operation request.")
        if (bytes > (registry.get(call.m)?.maxRequestBytes ?? defaultLimit)) reject(413, "Operation request exceeds the byte limit.")
        const response: { status?: number } = {}
        const context: OperationContext = {
          access: { mode: "local", sections: "all" }, development: true, surface: "cli", user: null, request, event: request, response,
          env: requestEnv(request), waitUntil: requestWaitUntil(request),
        }
        const reply = await answerOperationRpc(call, {
          failure: toOperationFailure,
          operations,
          run: async (operation, input) => {
            const result = await runOperation(registry, operation.name, input, context)
            if (!result.ok) throw Object.assign(new Error(result.message), result)
            return result.value
          },
          unknown: name => Object.assign(internalErrorDiagnostics.INTERNAL_R0021({ message: `No operation is named ${JSON.stringify(name)}.` }), { status: 404 }),
        })
        return Response.json(reply, { headers, status: "e" in reply ? reply.e.status : response.status ?? 200 })
      }
      catch (error) {
        const failure = toOperationFailure(error)
        return Response.json(operationRpcRefusal(failure), { headers, status: failure.status })
      }
    },
  }
}
