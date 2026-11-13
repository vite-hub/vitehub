import { consoleSignatureHeader, readConsolePublicKeys, verifyConsoleSignature } from "@vite-hub/internal/console-signature"
import { operationRpcPath } from "@vite-hub/internal/operation-rpc"
import { resolvePublicUrl } from "@vite-hub/runtime"
import { getStandardContext } from "@vite-hub/runtime/internal/h3"

import { consoleDiagnosticBody } from "../diagnostics.ts"

import type { ConsoleCaller, ConsoleSignatureCode } from "@vite-hub/internal/console-signature"
import type { ConsoleRequestEvent } from "./request.ts"

/** The outcome of `checkConsoleSignature()`. Only `withConsoleAccess()` turns `ok: true` into a Console access grant. */
export type ConsoleSignatureCheck =
  | { ok: true, caller: ConsoleCaller, key: string, bodySha256: string }
  | { ok: false, response: Response }

/** The `401` or `500` of a refused signature, with the Console diagnostic fields. */
export function consoleSignatureRejection(status: 401 | 500, code: ConsoleSignatureCode, message: string): Response {
  return Response.json({ ...consoleDiagnosticBody(code, message), ok: false, status }, {
    headers: {
      "cache-control": "no-store",
      ...(status === 401 ? { "www-authenticate": "VitehubSignature realm=\"vitehub-console\"" } : {}),
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
    status,
  })
}

/** The host environment of this request: the Cloudflare `env`, then `process.env` for the names it does not set. */
function requestEnv(event: ConsoleRequestEvent): Record<string, unknown> {
  return { ...globalThis.process?.env, ...getStandardContext(event).runtime?.cloudflare?.env }
}

/** Whether a path is the Console RPC route, below any application mount. */
export function isConsoleRpcPath(pathname: string): boolean {
  const route = pathname.indexOf(operationRpcPath)
  return route !== -1 && pathname.slice(route) === operationRpcPath
}

/**
 * Check the signature of a request to an app with `console: true`, before its body is read. The public keys come from
 * the `VITEHUB_CONSOLE_KEY_<NAME>` variables of the host env on each request, so a deploy or a Worker secret change
 * takes effect without a build.
 *
 * The signed origin must be the origin of this app: `vitehub({ publicUrl })` when it is set, else the URL of the request
 * as the host routed it. Node adapters build that URL from the caller's Host header, so they require a configured
 * public URL. Forwarding headers never supply the deployment identity.
 *
 * A match carries the signed body digest. The RPC route compares it with the bytes that it reads before it runs a call.
 * Signed requests reach only `POST /_vitehub/rpc`.
 */
export async function checkConsoleSignature(request: Request, event: ConsoleRequestEvent): Promise<ConsoleSignatureCheck> {
  const keys = readConsolePublicKeys(requestEnv(event))
  if (!(keys instanceof Map)) return { ok: false, response: consoleSignatureRejection(keys.status, keys.code, keys.message) }
  const url = new URL(request.url)
  if (request.method !== "POST" || !isConsoleRpcPath(url.pathname)) {
    return { ok: false, response: consoleSignatureRejection(401, "CONSOLE_SIGNATURE_INVALID", `Signed requests reach only POST ${operationRpcPath}.`) }
  }
  const nodeRequest = "runtime" in request && typeof request.runtime === "object" && request.runtime !== null && "node" in request.runtime
  const origin = resolvePublicUrl({ configuredOnly: nodeRequest, request })
  if (!origin) {
    // An unsigned request is an error of the caller. A signed request is an error of the app setup.
    if (!request.headers.has(consoleSignatureHeader)) return { ok: false, response: consoleSignatureRejection(401, "CONSOLE_SIGNATURE_MISSING", "This request is not signed.") }
    return { ok: false, response: consoleSignatureRejection(500, "CONSOLE_SIGNATURE_ORIGIN", "Signed requests on Node require vitehub({ publicUrl }) to identify this deployment. The request Host cannot supply its identity.") }
  }
  const verified = await verifyConsoleSignature({ headers: request.headers, keys, method: request.method, origin, url })
  if (!verified.ok) return { ok: false, response: consoleSignatureRejection(verified.status, verified.code, verified.message) }
  return verified
}
