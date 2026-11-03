import { validateViteHubNitroDevRequest } from "./dev-endpoint.ts"
import { assertOperationProject, createOperationRegistry, operationRootHeader, operationRpcHeader, operationsOf, projectRootHash, runOperation, toOperationFailure } from "./operations.ts"
import { getCloudflareEnv, resolveWaitUntil } from "./runtime/cloudflare-env.ts"
import { toEventRequest } from "./runtime/h3-v1-request.ts"

function readPath(value: unknown, ...path: string[]): unknown {
  for (const key of path) value = value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined
  return value
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

/** Bundled into owner packages and used only by their serve-only generated Nitro route. */
export function createStandaloneOperationHandler(sources: { operations: unknown, plugin: string }[], root: string): (event: object) => Promise<Response> {
  const registry = createOperationRegistry(sources.map(source => ({ ...source, operations: operationsOf(source.operations) })))
  const defaultLimit = 64 * 1_024
  const maximum = Math.max(defaultLimit, ...registry.list().map(operation => operation.maxRequestBytes ?? defaultLimit))
  return async (event) => {
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", [operationRootHeader]: projectRootHash(root) }
    try {
      const request = toEventRequest(event)
      const address = [readPath(event, "req", "ip"), readPath(event, "req", "context", "clientAddress"), readPath(event, "req", "runtime", "node", "req", "socket", "remoteAddress"), readPath(event, "node", "req", "socket", "remoteAddress")].find((value): value is string => typeof value === "string" && value !== "")
      const forwarded = request.headers.get("x-forwarded-host")
      if (!localHost(request.headers.get("host") ?? new URL(request.url).host) || (forwarded && !localHost(forwarded)) || (address && address !== "::1" && !address.startsWith("127.") && !address.startsWith("::ffff:127."))) reject(403, "Standalone development operations accept only local requests.")
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
      if (!payload || typeof payload !== "object" || !("operation" in payload) || typeof payload.operation !== "string") reject(400, "Invalid operation request.")
      if (bytes > (registry.get(payload.operation)?.maxRequestBytes ?? defaultLimit)) reject(413, "Operation request exceeds the byte limit.")
      const response: { status?: number } = {}
      const result = await runOperation(registry, payload.operation, "input" in payload ? payload.input : undefined, {
        access: { mode: "local", sections: "all" }, development: true, surface: "cli", user: null, request, response,
        env: getCloudflareEnv(event, { fallback: false }), waitUntil: resolveWaitUntil(event, { preferHost: true }),
      })
      return Response.json(result, { headers, status: result.ok ? response.status ?? 200 : result.status })
    }
    catch (error) {
      const failure = toOperationFailure(error)
      return Response.json({ ok: false, ...failure }, { headers, status: failure.status })
    }
  }
}
