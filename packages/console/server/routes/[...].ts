import page from "#console-page"

import { consolePagePolicy, renderConsolePage } from "../../src/page.ts"

const headers = {
  "cache-control": "no-cache",
  "content-type": "text/html; charset=utf-8",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  "referrer-policy": "no-referrer",
  // The first paint depends on the session and view cookies.
  vary: "cookie",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
}

// Console routes, such as /kv or /invite/<id>, are client routes. They all get the page. API, MCP, and well-known paths
// that no route answers stay 404, so an MCP client finds no OAuth metadata for /mcp.
export default {
  fetch(request: Request): Response {
    const { pathname } = new URL(request.url)
    if (/^\/(?:api|p|assets|mcp|\.well-known)(?:\/|$)/.test(pathname)) return Response.json({ code: "NOT_FOUND", message: "Not found.", ok: false, status: 404 }, { status: 404 })
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { headers: { allow: "GET, HEAD" }, status: 405 })
    // A new script nonce for each page. See consolePagePolicy().
    return new Response(request.method === "HEAD" ? null : renderConsolePage(page, request), { headers: { ...headers, "content-security-policy": consolePagePolicy() } })
  },
}
