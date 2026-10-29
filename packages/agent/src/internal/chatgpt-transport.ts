import { randomBytes } from "node:crypto"
import { once } from "node:events"
import { createServer, request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ClientRequest, IncomingHttpHeaders } from "node:http"
import type { ChatGPTCredential } from "@vite-hub/connections/agent"
import { isViteHubBearerSecretEqual } from "@vite-hub/internal/secret"

const requestHeaders = new Set([
  "accept", "content-type", "openai-beta", "originator", "user-agent", "version",
  "session_id", "conversation_id", "x-client-request-id",
])

function upstreamHeaders(headers: IncomingHttpHeaders, token: string): IncomingHttpHeaders {
  return {
    ...Object.fromEntries(Object.entries(headers).filter(([key]) => requestHeaders.has(key) || key.startsWith("x-codex-"))),
    authorization: `Bearer ${token}`,
    // The response is streamed as text and redacted before reaching Codex.
    "accept-encoding": "identity",
  }
}

function redactToken(token: string): Transform {
  const secret = Buffer.from(token)
  let pending = Buffer.alloc(0)
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending = Buffer.concat([pending, chunk])
      let match: number
      while ((match = pending.indexOf(secret)) !== -1) {
        this.push(pending.subarray(0, match))
        this.push("[REDACTED]")
        pending = pending.subarray(match + secret.length)
      }
      // Hold only an actual token prefix, so short SSE events can flow immediately.
      let safe = Math.max(0, pending.length - secret.length + 1)
      while (safe < pending.length && !pending.subarray(safe).equals(secret.subarray(0, pending.length - safe))) safe++
      this.push(pending.subarray(0, safe))
      pending = pending.subarray(safe)
      callback()
    },
    flush(callback) {
      this.push(pending)
      callback()
    },
  })
}

/** Keep the grant in runtime memory, outside same-user readable child environments and files. */
export async function startChatGPTTransport(credential: ChatGPTCredential, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const key = randomBytes(32).toString("hex")
  const active = new Set<ClientRequest>()
  let closing: Promise<void> | undefined
  const server = createServer((request, response) => {
    const path = request.url?.split("?")[0]
    if (Date.now() >= credential.expiresAt || !isViteHubBearerSecretEqual(request.headers.authorization, key)) {
      response.writeHead(401).end()
      return
    }
    // Never accept a caller-selected upstream, redirects, or additional API routes.
    if (!((request.method === "POST" && path === "/responses") || (request.method === "GET" && path === "/models"))) {
      response.writeHead(404).end()
      return
    }
    const target = new URL(`${credential.api.replace(/\/$/, "")}${request.url}`)
    const upstream = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
      method: request.method,
      headers: upstreamHeaders(request.headers, credential.accessToken),
    }, (incoming) => {
      const headers = Object.fromEntries(Object.entries(incoming.headers).filter(([name]) =>
        ["content-type", "retry-after", "x-request-id"].includes(name) || name.startsWith("x-codex-") || name.startsWith("x-ratelimit-"),
      ).map(([name, value]) => [name, Array.isArray(value)
        ? value.map(item => item.replaceAll(credential.accessToken, "[REDACTED]"))
        : value?.replaceAll(credential.accessToken, "[REDACTED]")]))
      // Node's HTTP client does not follow redirects; suppress Location and cookies too.
      response.writeHead(incoming.statusCode ?? 502, headers)
      void pipeline(incoming, redactToken(credential.accessToken), response).catch(() => response.destroy())
    })
    active.add(upstream)
    upstream.on("close", () => active.delete(upstream))
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502).end()
      else response.destroy()
    })
    request.on("error", () => upstream.destroy())
    response.on("close", () => upstream.destroy())
    request.pipe(upstream)
  })
  const close = () => closing ??= new Promise<void>((resolve) => {
    signal?.removeEventListener("abort", abort)
    server.close(() => resolve())
    server.closeAllConnections()
    for (const upstream of active) upstream.destroy()
  })
  const abort = () => { void close() }
  server.listen(0, "127.0.0.1")
  try {
    await once(server, "listening")
    signal?.addEventListener("abort", abort, { once: true })
    signal?.throwIfAborted()
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("ChatGPT transport did not bind a loopback port.")
    return { url: `http://127.0.0.1:${address.port}`, key, close }
  }
  catch (error) {
    await close()
    throw error
  }
}
