import { defineEventHandler, getRequestHeaders } from "h3"

const defaultBridgeOrigin = "http://127.0.0.1:3402"
const bridgeRoute = "/__vitehub/agent/chat/devtools"

function bridgeOrigin() {
  return process.env.VITEHUB_CHAT_DEVTOOLS_BRIDGE_ORIGIN || defaultBridgeOrigin
}

function proxyHeaders(event: Parameters<typeof getRequestHeaders>[0]): Headers {
  const headers = new Headers(getRequestHeaders(event))
  headers.delete("host")
  headers.delete("content-length")
  return headers
}

async function readNodeRequestBody(event: Parameters<typeof getRequestHeaders>[0]): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of event.node.req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export default defineEventHandler(async (event) => {
  const response = await fetch(new URL(bridgeRoute, bridgeOrigin()), {
    body: await readNodeRequestBody(event),
    headers: proxyHeaders(event),
    method: "POST",
  })

  return new Response(response.body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  })
})
