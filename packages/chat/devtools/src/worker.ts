export interface Env {
  ASSETS: {
    fetch(request: Request): Promise<Response>
  }
}

const htmlHeaders = {
  "cache-control": "no-cache",
  "content-security-policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
    "frame-ancestors http://localhost:* http://127.0.0.1:*",
    "img-src 'self' data:",
    "script-src 'self'",
    "style-src 'self'",
  ].join("; "),
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
}

const assetHeaders = {
  "cache-control": "public, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
}

function withHeaders(response: Response, headers: Record<string, string>) {
  const nextHeaders = new Headers(response.headers)
  for (const [name, value] of Object.entries(headers)) {
    nextHeaders.set(name, value)
  }
  nextHeaders.delete("x-frame-options")
  return new Response(response.body, {
    headers: nextHeaders,
    status: response.status,
    statusText: response.statusText,
  })
}

function createAssetRequest(request: Request) {
  const url = new URL(request.url)
  if (url.pathname === "/" || url.pathname === "/chat" || url.pathname === "/chat/") {
    url.pathname = "/"
  }
  return new Request(url, request)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const response = await env.ASSETS.fetch(createAssetRequest(request))

    if (url.pathname === "/" || url.pathname === "/chat" || url.pathname === "/chat/") {
      return withHeaders(response, htmlHeaders)
    }

    if (url.pathname.startsWith("/assets/")) {
      return withHeaders(response, assetHeaders)
    }

    return response
  },
}
