import { describe, expect, it } from "vitest"

import { connectionAccessRule, decideConnectionAccess, matchesConnectionPattern } from "../src/access.ts"
import { resolveConnectionActor, routeConnectionActor, serverConnectionActor } from "../src/actor.ts"
import { assertConnectionOrigins, matchesConnectionOrigin } from "../src/origins.ts"

import type { ConnectionAccess, ConnectionActor } from "../src/types.ts"

const read = { effect: "read", id: "gmail.messages.list" } as const
const write = { effect: "write", id: "gmail.messages.modify" } as const
const agent: ConnectionActor = { id: "triage", kind: "agent" }
const route: ConnectionActor = { id: "POST /api/labels/:id", kind: "route" }

describe("matchesConnectionPattern", () => {
  it("matches exact ids and globs across dots", () => {
    expect(matchesConnectionPattern(["gmail.messages.list"], "gmail.messages.list")).toBe(true)
    expect(matchesConnectionPattern(["gmail.*"], "gmail.messages.list")).toBe(true)
    expect(matchesConnectionPattern(["*"], "anything.at.all")).toBe(true)
    expect(matchesConnectionPattern(["gmail.*.list"], "gmail.labels.list")).toBe(true)
    expect(matchesConnectionPattern(["*.list"], "gmail.labels.get")).toBe(false)
    expect(matchesConnectionPattern(["gmail.messages"], "gmail.messages.list")).toBe(false)
  })

  it("treats regular expression characters as literals", () => {
    expect(matchesConnectionPattern(["gmail.labels.get"], "gmailxlabelsxget")).toBe(false)
    expect(matchesConnectionPattern(["a+b"], "aab")).toBe(false)
    expect(matchesConnectionPattern(["a+b"], "a+b")).toBe(true)
    expect(matchesConnectionPattern(["(x)|y"], "y")).toBe(false)
    expect(matchesConnectionPattern(["fetch.[get]"], "fetch.g")).toBe(false)
  })

  it("does not match without patterns", () => {
    expect(matchesConnectionPattern(undefined, "gmail.messages.list")).toBe(false)
    expect(matchesConnectionPattern([], "gmail.messages.list")).toBe(false)
  })
})

describe("connectionAccessRule", () => {
  const access: ConnectionAccess = {
    agents: { triage: { allow: ["agent.*"] } },
    routes: { "POST /api/labels/:id": { allow: ["route.*"] } },
    server: { allow: ["server.*"] },
  }

  it("uses the Agent rule only for Agents", () => {
    expect(connectionAccessRule(access, agent)).toEqual({ allow: ["agent.*"] })
    expect(connectionAccessRule(access, { id: "other", kind: "agent" })).toBeUndefined()
  })

  it("uses the route rule, then the server rule, for routes", () => {
    expect(connectionAccessRule(access, route)).toEqual({ allow: ["route.*"] })
    expect(connectionAccessRule(access, { id: "GET /api/other", kind: "route" })).toEqual({ allow: ["server.*"] })
  })

  it("uses the server rule for other actors", () => {
    for (const kind of ["schedule", "service", "user"] as const) {
      expect(connectionAccessRule(access, { id: "x", kind })).toEqual({ allow: ["server.*"] })
    }
    expect(connectionAccessRule(undefined, serverConnectionActor)).toBeUndefined()
  })
})

describe("decideConnectionAccess", () => {
  it("allows reads and denies writes without a rule", () => {
    expect(decideConnectionAccess(undefined, serverConnectionActor, read)).toBe("allow")
    expect(decideConnectionAccess(undefined, serverConnectionActor, write)).toBe("deny")
    expect(decideConnectionAccess({ server: { allow: ["other.*"] } }, serverConnectionActor, write)).toBe("deny")
  })

  it("applies deny, then approve, then allow", () => {
    const all = { allow: ["gmail.*"], approve: ["gmail.messages.*"], deny: ["gmail.messages.modify"] }
    expect(decideConnectionAccess({ server: all }, serverConnectionActor, write)).toBe("deny")
    expect(decideConnectionAccess({ server: all }, serverConnectionActor, read)).toBe("require-approval")
    expect(decideConnectionAccess({ server: all }, serverConnectionActor, { effect: "write", id: "gmail.labels.create" })).toBe("allow")
  })

  it("denies reads that match a deny pattern", () => {
    expect(decideConnectionAccess({ server: { deny: ["gmail.messages.*"] } }, serverConnectionActor, read)).toBe("deny")
  })

  it("does not give Agents the server rule", () => {
    const access: ConnectionAccess = { server: { allow: ["*"] } }
    expect(decideConnectionAccess(access, serverConnectionActor, write)).toBe("allow")
    expect(decideConnectionAccess(access, agent, write)).toBe("deny")
    expect(decideConnectionAccess(access, agent, read)).toBe("allow")
    expect(decideConnectionAccess({ ...access, agents: { triage: { allow: ["gmail.messages.*"] } } }, agent, write)).toBe("allow")
  })

  it("gives routes without their own rule the server rule", () => {
    const access: ConnectionAccess = { routes: { "POST /api/labels/:id": { deny: ["*"] } }, server: { allow: ["*"] } }
    expect(decideConnectionAccess(access, route, read)).toBe("deny")
    expect(decideConnectionAccess(access, { id: "POST /api/other", kind: "route" }, write)).toBe("allow")
  })
})

describe("Connection origins", () => {
  it("matches exact origins and subdomain wildcards", () => {
    const origins = assertConnectionOrigins(["https://API.example.com", "https://*.googleapis.com", "http://localhost:8787", "https://default.example:443", "http://127.0.0.1:80"])
    // Default ports are normalized, as `URL.port` is empty for them.
    expect(matchesConnectionOrigin(origins, new URL("https://default.example/x"))).toBe(true)
    expect(matchesConnectionOrigin(origins, new URL("http://127.0.0.1:80/x"))).toBe(true)
    expect(matchesConnectionOrigin(origins, new URL("https://api.example.com/v1?x=1"))).toBe(true)
    expect(matchesConnectionOrigin(origins, new URL("https://gmail.googleapis.com/gmail/v1"))).toBe(true)
    expect(matchesConnectionOrigin(origins, new URL("http://localhost:8787/x"))).toBe(true)
    for (const url of ["https://googleapis.com/x", "https://evil.com/?https://api.example.com", "https://api.example.com.evil.com/", "http://api.example.com/", "https://api.example.com:8443/", "http://localhost:8788/"]) {
      expect(matchesConnectionOrigin(origins, new URL(url))).toBe(false)
    }
  })

  it("matches default ports in origins that a custom provider did not normalize", () => {
    expect(matchesConnectionOrigin(["https://api.example.com:443"], new URL("https://api.example.com/x"))).toBe(true)
  })

  it("normalizes leading zeros in default and nondefault ports", () => {
    for (const [origin, request] of [
      ["https://api.example.com:0443", "https://api.example.com/x"],
      ["http://localhost:080", "http://localhost/x"],
      ["https://*.example.com:0443", "https://api.example.com/x"],
      ["https://api.example.com:08443", "https://api.example.com:8443/x"],
    ]) {
      const url = new URL(request!)
      expect(matchesConnectionOrigin(assertConnectionOrigins([origin]), url)).toBe(true)
      expect(matchesConnectionOrigin([origin!], url)).toBe(true)
      expect(matchesConnectionOrigin([origin!], new URL(`${url.protocol}//${url.hostname}:9443/x`))).toBe(false)
    }
  })

  it("rejects missing or malformed origins, and plain http for remote hosts", () => {
    for (const origins of [undefined, [], ["api.example.com"], ["https://api.example.com/v1"], ["https://user@api.example.com"], ["ftp://api.example.com"], ["https://a.*.example.com"], ["http://api.example.com"], ["http://*.localhost"]]) {
      expect(() => assertConnectionOrigins(origins)).toThrow("Invalid Connection request.")
    }
  })
})

describe("Connection actors", () => {
  it("uses the matched route pattern of an H3 event", () => {
    expect(routeConnectionActor({ context: { matchedRoute: { route: "/api/labels/:id" } }, method: "post", path: "/api/labels/1" }))
      .toEqual({ id: "POST /api/labels/:id", kind: "route" })
  })

  it("uses the request path without the query when no route matched", () => {
    expect(routeConnectionActor({ method: "GET", path: "/api/labels?secret=1" })).toEqual({ id: "GET /api/labels", kind: "route" })
    expect(routeConnectionActor({ req: { method: "PUT", url: "http://localhost/api/x?y=1" } })).toEqual({ id: "PUT /api/x", kind: "route" })
    expect(routeConnectionActor({ req: { method: "DELETE" }, url: new URL("https://app.example/api/z?q=1") })).toEqual({ id: "DELETE /api/z", kind: "route" })
  })

  it("reads H3 1 requests from event.node.req", () => {
    expect(routeConnectionActor({ context: {}, node: { req: { method: "post", url: "/api/labels/1?x=1" } } })).toEqual({ id: "POST /api/labels/1", kind: "route" })
    expect(routeConnectionActor({ context: { matchedRoute: { route: "/api/labels/:id" } }, node: { req: { method: "PATCH", url: "/api/labels/1" } } }))
      .toEqual({ id: "PATCH /api/labels/:id", kind: "route" })
  })

  it("returns no route actor for events without a method or path", () => {
    expect(routeConnectionActor(undefined)).toBeUndefined()
    expect(routeConnectionActor({ path: "/api" })).toBeUndefined()
    expect(routeConnectionActor({ method: "GET" })).toBeUndefined()
  })

  it("prefers an explicit actor, then the route, then the server", () => {
    expect(resolveConnectionActor({ actor: agent, event: { method: "GET", path: "/x" } })).toBe(agent)
    expect(resolveConnectionActor({ event: { method: "GET", path: "/x" } })).toEqual({ id: "GET /x", kind: "route" })
    expect(resolveConnectionActor({})).toBe(serverConnectionActor)
  })
})
