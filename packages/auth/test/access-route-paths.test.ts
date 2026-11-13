import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { H3, H3Event } from "h3"
import { addRoute, createRouter } from "rou3"
import { compileRouter } from "rou3/compiler"
import { describe, expect, it, vi } from "vitest"

import { resolveAuthViteConfig } from "../src/config.ts"
import { defineAuth } from "../src/index.ts"
import { createAuthAccessRouteMatcher, createLazyAuthAccessHandler } from "../src/runtime/server.ts"

const access = [{ route: "/api/billing" }, { route: "/api/admin/**" }, { route: "/café" }]

// Spellings of a guarded path that H3 and rou3 route to the same handler.
const paths = [
  "/api/billing",
  "/api/billing/",
  "/api/%62illing",
  "/api/%62illing/",
  "/%61pi/billing",
  "/api/x/../billing",
  "/api/x/%2e%2e/billing",
  "/api/admin",
  "/api/admin/",
  "/api/%61dmin",
  "/api/%61dmin/users",
  "/api/admin/users/",
  "/caf%C3%A9",
  "/caf%C3%A9/",
]

describe("Auth access route paths", () => {
  it("guards every path that the Nitro router sends to a guarded handler", () => {
    const router = createRouter<string>()
    for (const route of ["/api/billing", "/api/admin/**", "/caf%C3%A9", "/api/**", "/**"]) addRoute(router, "", route, route)
    const find = compileRouter(router)
    const match = createAuthAccessRouteMatcher(access)
    const guarded = new Set(["/api/billing", "/api/admin/**", "/caf%C3%A9"])

    for (const path of paths) {
      const request = new Request(`https://app.example${path}`)
      // Nitro routes on the pathname of the H3 event, with the compiled rou3 router.
      const handler = find("GET", new H3Event(request).url.pathname)?.data
      expect(handler && guarded.has(handler), path).toBe(true)
      expect(match(request), path).not.toEqual([])
    }
  })

  it("never lets an H3 app run a guarded handler without the access check", async () => {
    const check = vi.fn(async () => new Response("denied", { status: 401 }))
    const guard = createLazyAuthAccessHandler(access, async () => ({ createAuthAccessHandler: () => check }))
    const app = new H3()
      .use(async event => await guard(new Request(event.req.url, { method: event.req.method })))
      .get("/api/billing", () => "billing")
      .get("/api/admin/**", () => "admin")
      .get("/café", () => "café")

    for (const path of paths) {
      const response = await app.request(path)
      expect(`${path} ${response.status} ${await response.text()}`).toBe(`${path} 401 denied`)
    }
  })

  it("leaves other paths unguarded", () => {
    const match = createAuthAccessRouteMatcher(access)
    for (const path of ["/api/billings", "/api/billing/x", "/api/administrator", "/API/billing", "/api//billing", "/cafe"]) {
      expect(match(new Request(`https://app.example${path}`)), path).toEqual([])
    }
  })

  it.each(["/api/admin/*", "/api/users/:id", "/api/(admin)", "/api/{admin}", "/api/**/users", "/api/a**", "/**/x", "/api/admin?", "/api\\admin"])(
    "rejects route pattern syntax in %s",
    async (route) => {
      expect(() => defineAuth({ access: { routes: [route] } })).toThrow(expect.objectContaining({ code: "AUTH_C0063" }))
      expect(() => defineAuth({ access: { routes: [{ route }] } })).toThrow(expect.objectContaining({ code: "AUTH_C0063" }))

      const rootDir = await mkdtemp(join(tmpdir(), "vitehub-auth-route-"))
      try {
        await mkdir(join(rootDir, "server"), { recursive: true })
        for (const entry of [JSON.stringify(route), `{ route: ${JSON.stringify(route)} }`]) {
          await writeFile(join(rootDir, "server/auth.ts"), `import { defineAuth } from '@vite-hub/auth'\nexport default defineAuth({ access: { routes: [${entry}] } })\n`)
          expect(() => resolveAuthViteConfig(undefined, rootDir)).toThrow(expect.objectContaining({ code: "AUTH_C0063" }))
        }
      }
      finally {
        await rm(rootDir, { force: true, recursive: true })
      }
    },
  )

  it("accepts literal paths and a final /**", () => {
    expect(() => defineAuth({ access: { routes: ["/", "/**", "/api/billing", "/api/admin/**", "/files/a+b.txt", "/café"] } })).not.toThrow()
  })
})
