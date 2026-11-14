import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { useViteHubDevPeerKey, viteHubDevPeerDevHandler, viteHubDevPeerKeyEnv } from "@vite-hub/internal/dev-peer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { addConsoleRpcHandler } from "../src/console/nitro.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { consoleRealtimeAccess, installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleDevelopment } from "../src/console/runtime/server/development.ts"
import { loadConsoleRuntime } from "../src/console/runtime/server/runtime.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { consoleBuiltinSectionIds } from "../src/console/runtime/sections.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"
import { consoleEvent, routeRequest } from "./console-event.ts"

import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"

// A route that a request reaches runs its own logic only after the Console runtime loads.
vi.mock("../src/console/runtime/server/runtime.ts", () => ({ loadConsoleRuntime: vi.fn(async () => undefined) }))

type Registration = { handler: string, method?: string | string[], middleware?: boolean, route?: string }

const sections = [...consoleBuiltinSectionIds, "auth", "schedules"]
const serverRoot = new URL("../src/console/runtime/server/", import.meta.url)
// What a remote client sends to look local: the dev server's own Host, and the proxy headers of a local peer.
const forgedLocal = { "host": "localhost:3000", "origin": "http://localhost:3000", "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "localhost:3000", "x-real-ip": "127.0.0.1" }

/**
 * Routes that answer a remote client without Console access, and why each one is safe.
 * - `page-session.ts`: the page tools session. It only says which page tools this visitor gets. The Console link asks
 *   `consolePageToolAllowed()`, which `console-page-tool.test.ts` covers, and the link gives no access.
 */
const outsideConsoleAccess = new Set(["page-session.ts"])

/** The Console routes that the Vite plugin and the Nuxt module register, with every section on and no sign-in. */
async function registeredConsoleRoutes(): Promise<Registration[]> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-console-loopback-"))
  try {
    await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "console-loopback" })}\n`)
    const plugin = consoleVitePlugin({ console: { auth: false }, sections })
    const configHook = plugin.config
    if (!configHook) throw new TypeError("Expected a Console config hook.")
    const config: { nitro?: { handlers: Registration[] }, root: string } = { root }
    await Reflect.apply("handler" in configHook ? configHook.handler : configHook, {}, [config, { command: "serve", mode: "development" }])
    const nuxt: { handlers?: Registration[] } = {}
    addConsoleRpcHandler(nuxt, "/runtime")
    const all = [...config.nitro?.handlers ?? [], ...nuxt.handlers ?? []].filter(entry => !entry.middleware && entry.route)
    return all.filter((entry, index) => all.findIndex(other => other.route === entry.route && other.handler.endsWith(basename(entry.handler))) === index)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** The source module of a registered route: `<runtime>/server/<name>.js` is `src/console/runtime/server/<name>.ts`. */
function sourceFile(handler: string): string {
  const match = /\/server\/([\w.-]+)\.js$/.exec(handler)
  if (!match) throw new TypeError(`${handler} is not a Console server route.`)
  return `${match[1]}.ts`
}

/** One request for a registered route: the concrete path for a `**` route, and its method. */
function remoteRequest(entry: Registration, remoteAddress?: string): ConsoleRequestEvent {
  const path = entry.route!.replace("/**", "/agents")
  const method = [entry.method ?? "post"].flat()[0]!.toUpperCase()
  return consoleEvent({
    url: `http://localhost:3000${path}`,
    method,
    headers: { ...forgedLocal, "accept": "application/json", "content-type": "application/json", [consoleRpcHeader]: "1" },
    ...(method === "GET" ? {} : { body: { input: {}, operation: "definitions.list" } }),
    ...(remoteAddress ? { remoteAddress } : {}),
  })
}

async function codeOf(response: Response): Promise<unknown> {
  try {
    return Reflect.get(Object(await response.json()), "code")
  }
  catch {
    return undefined
  }
}

beforeEach(() => {
  installConsoleDevelopment("/work/app", true)
  installConsoleSections("/work/app", sections)
})

afterEach(() => {
  vi.unstubAllEnvs()
  Reflect.deleteProperty(process.env, viteHubDevPeerKeyEnv)
  installConsoleDevelopment("/work/app", false)
  installConsoleAccess({ mode: "open" })
  vi.mocked(loadConsoleRuntime).mockClear()
})

describe.each(["local", "open"] as const)("every Console route of a %s development Console", (mode) => {
  beforeEach(() => installConsoleAccess({ mode }))

  // Let cold route imports finish before another test changes the process-wide access policy.
  it("refuses a remote client with CONSOLE_LOOPBACK_ONLY before the route runs", { timeout: 30_000 }, async () => {
    const routes = await registeredConsoleRoutes()
    const files = new Set(routes.map(entry => sourceFile(entry.handler)))
    // A route that this list does not name must be classified here, so no Console route skips the rule.
    expect([...files].sort()).toEqual(["page-session.ts", "rpc.ts", "site-entry.ts"])
    const guarded = routes.filter(entry => !outsideConsoleAccess.has(sourceFile(entry.handler)))
    for (const peer of [
      // A dev worker behind the front process's proxy sees no address. The front process gave it a key, and no evidence.
      { key: true, remoteAddress: undefined },
      // Nuxt 5 nightly reaches its worker over TCP, so the worker sees the proxy on 127.0.0.1 for every client.
      { key: true, remoteAddress: "127.0.0.1" },
      // Plain `vite dev` reports the client's address.
      { key: false, remoteAddress: "192.168.0.38" },
      // A local tunnel has a loopback socket and a localhost Host, but sends forwarding headers.
      { key: false, remoteAddress: "127.0.0.1" },
      // Without a key and without an address, nothing proves the peer.
      { key: false, remoteAddress: undefined },
    ]) {
      if (peer.key) useViteHubDevPeerKey()
      else vi.stubEnv(viteHubDevPeerKeyEnv, undefined)
      for (const entry of guarded) {
        const label = `${entry.route} (${sourceFile(entry.handler)}), key ${peer.key}, address ${peer.remoteAddress}`
        const route: unknown = (await import(new URL(sourceFile(entry.handler), serverRoot).href)).default
        if (!(route instanceof Object) || !("fetch" in route) || !(route.fetch instanceof Function)) throw new TypeError(`${label} must default-export a Fetchable route.`)
        const response: unknown = await route.fetch(routeRequest(remoteRequest(entry, peer.remoteAddress)))
        if (!(response instanceof Response)) throw new TypeError(`${label} must answer with a Response.`)
        expect(response.status, label).toBe(403)
        await expect(codeOf(response), label).resolves.toBe("CONSOLE_LOOPBACK_ONLY")
      }
      expect(loadConsoleRuntime).not.toHaveBeenCalled()
      vi.unstubAllEnvs()
    }
  })

  it("serves the same routes to this machine", { timeout: 30_000 }, async () => {
    useViteHubDevPeerKey()
    const routes = await registeredConsoleRoutes()
    for (const entry of routes) {
      const request = remoteRequest(entry)
      const standard = request["~standard"]
      const url = new URL(standard.req.url)
      // The front process signs the request of a loopback socket before Nitro forwards it.
      const node = { headers: { host: "localhost:3000" } as Record<string, string>, method: standard.req.method, socket: { remoteAddress: "127.0.0.1" }, url: url.pathname }
      await viteHubDevPeerDevHandler({ runtime: { node: { req: node } } })
      standard.req.headers.set("x-vitehub-dev-peer", node.headers["x-vitehub-dev-peer"]!)
      standard.req.headers.delete("x-forwarded-host")
      const route: unknown = (await import(new URL(sourceFile(entry.handler), serverRoot).href)).default
      if (!(route instanceof Object) || !("fetch" in route) || !(route.fetch instanceof Function)) throw new TypeError(`${entry.route} must default-export a Fetchable route.`)
      // Past access, a route can still fail on state that this test does not install. That failure is not a refusal.
      const response: unknown = await Promise.resolve(route.fetch(routeRequest(request))).catch((error: unknown) => error)
      const code = response instanceof Response ? await codeOf(response) : undefined
      expect(code, `${entry.route} (${sourceFile(entry.handler)})`).not.toBe("CONSOLE_LOOPBACK_ONLY")
    }
    expect(loadConsoleRuntime).toHaveBeenCalled()
  })
})

describe("Console access outside its routes", () => {
  beforeEach(() => {
    installConsoleAccess({ mode: "open" })
    useViteHubDevPeerKey()
  })

  const remote = () => consoleEvent({ url: "http://localhost:3000/api/_vitehub/realtime/content/doc", headers: forgedLocal })

  it("closes Console Realtime rooms to a remote client", async () => {
    const access = consoleRealtimeAccess("agents")
    expect(await access.authorize({ event: remote(), kind: "read" })).toBe(false)
    expect(await access.identify({ event: remote() })).toBeNull()
    expect(await access.user({ event: remote() })).toBeNull()
  })
})
