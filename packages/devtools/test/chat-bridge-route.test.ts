import { describe, expect, it } from "vitest"

import { resolveChatBridgeRoute } from "../devtools/chat/app/bridge-route.ts"

describe("resolveChatBridgeRoute", () => {
  it("targets the inspected app origin when opened from Vite DevTools", () => {
    expect(resolveChatBridgeRoute({
      pathname: "/chat/",
      remoteOrigin: "http://127.0.0.1:3000",
    })).toBe("http://127.0.0.1:3000/__vitehub/agent/chat/devtools")
  })

  it("keeps the internal standalone chat client demo bridge when no inspected app origin exists", () => {
    expect(resolveChatBridgeRoute({
      pathname: "/chat/",
    })).toBe("/chat/__vitehub/agent/chat/devtools")
  })

  it("keeps the standalone demo bridge at the chat base path without a trailing slash", () => {
    expect(resolveChatBridgeRoute({
      pathname: "/chat",
    })).toBe("/chat/__vitehub/agent/chat/devtools")
  })

  it("falls back to iframe ancestry outside the standalone chat path", () => {
    expect(resolveChatBridgeRoute({
      ancestorOrigin: "http://127.0.0.1:3000",
      pathname: "/",
    })).toBe("http://127.0.0.1:3000/__vitehub/agent/chat/devtools")
  })
})
