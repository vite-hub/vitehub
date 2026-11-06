import { afterEach, describe, expect, it, vi } from "vitest"
import * as v from "valibot"
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { useViteHubDevPeerKey, viteHubDevPeerDevHandler, viteHubDevPeerHeader, viteHubDevPeerKeyEnv } from "../src/dev-peer.ts"
import { createStandaloneOperationHandler } from "../src/operations-dev.ts"
import { publishStandaloneOperationServer } from "../src/operations-vite.ts"
import { findViteHubDevServerUrl, readViteHubDevServerFile } from "../src/cli.ts"
import { callOperationFromCli, defineOperation, operationExpectedRootsHeader, projectRootHash } from "../src/operations.ts"

function fixture() {
  const run = vi.fn((input: { text: string }) => input.text)
  const operation = defineOperation({ name: "test.echo", description: "Echo.", input: v.object({ text: v.string() }), kind: "write", section: "test", run })
  const large = defineOperation({ ...operation, name: "test.large", maxRequestBytes: 128 * 1024 })
  const handler = createStandaloneOperationHandler([{ operations: [operation, large], plugin: "test" }], "/server/project")
  // `ip` is the peer address that the host reports, as plain `vite dev` does. `null` is a peer with no address.
  const request = (body: unknown, headers: Record<string, string> = {}, url = "http://localhost/_vitehub/rpc/__call", ip: string | null = "127.0.0.1") => Object.assign(new Request(url, {
    method: "POST", headers: { "content-type": "application/json", "x-vitehub-console": "1", ...headers }, body: JSON.stringify(body),
  }), ip ? { ip } : {})
  return { handler, run, request }
}

afterEach(() => {
  vi.unstubAllEnvs()
  Reflect.deleteProperty(process.env, viteHubDevPeerKeyEnv)
})

describe("local operation RPC", () => {
  it("uses project identity for discovered targets but not explicit deployment URLs", async () => {
    const { handler, run } = fixture()
    const fetch: typeof globalThis.fetch = (url, init) => handler({ req: Object.assign(new Request(url, init), { ip: "127.0.0.1" }) })
    const result = await callOperationFromCli({ rootDir: "/client/project", env: {}, url: "http://localhost", fetch }, "test.echo", { text: "deployed" })
    expect(result).toEqual({ ok: true, value: "deployed" })
    const stale = await callOperationFromCli({ rootDir: "/client/project", env: { VITEHUB_DEV_SERVER_URL: "http://localhost" }, fetch }, "test.echo", { text: "wrong project" })
    expect(stale).toMatchObject({ ok: false, code: "INTERNAL_R0025" })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it.each([
    { origin: "https://foreign.test" }, { "sec-fetch-site": "cross-site" }, { host: "attacker.test" },
    { "x-forwarded-host": "public.test" }, { "x-vitehub-console": "" },
  ])("refuses an untrusted request before running an operation: %j", async (headers) => {
    const { handler, run, request } = fixture()
    expect((await handler({ req: request({ operation: "test.echo", input: { text: "unsafe" } }, headers) })).status).toBe(403)
    expect(run).not.toHaveBeenCalled()
  })

  it("rejects a nonlocal peer even with a localhost Host", async () => {
    const { handler, run, request } = fixture()
    const req = request({ operation: "test.echo", input: { text: "unsafe" } })
    Object.assign(req, { ip: "192.0.2.4" })
    expect((await handler({ req })).status).toBe(403)
    expect(run).not.toHaveBeenCalled()
  })

  it("refuses a peer without an address, whatever headers it sends", async () => {
    const { handler, run, request } = fixture()
    const forged = { "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" }
    expect((await handler({ req: request({ operation: "test.echo", input: { text: "unsafe" } }, forged, undefined, null) })).status).toBe(403)
    expect(run).not.toHaveBeenCalled()
  })

  it("trusts only the front process's evidence when the worker has a key", async () => {
    const { handler, run, request } = fixture()
    useViteHubDevPeerKey()
    const signed = async (remoteAddress: string, headers: Record<string, string> = {}) => {
      const req = { headers: { host: "localhost", ...headers }, method: "POST", socket: { remoteAddress }, url: "/_vitehub/rpc/__call" }
      await viteHubDevPeerDevHandler({ node: { req } })
      return Object.fromEntries(Object.entries(req.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    }
    const body = { operation: "test.echo", input: { text: "local" } }
    // A dev worker behind the front process's proxy sees no address, or the proxy on 127.0.0.1.
    expect((await handler({ req: request(body, await signed("127.0.0.1"), undefined, null) })).status).toBe(200)
    expect((await handler({ req: request(body, await signed("127.0.0.1")) })).status).toBe(200)
    expect(run).toHaveBeenCalledTimes(2)
    expect((await handler({ req: request(body, await signed("192.168.0.38", { [viteHubDevPeerHeader]: "v1.forged" })) })).status).toBe(403)
    // A tunnel on this machine connects from 127.0.0.1 and adds the address of the client it forwards.
    expect((await handler({ req: request(body, await signed("127.0.0.1", { "x-forwarded-for": "203.0.113.9" }), undefined, null) })).status).toBe(403)
    expect((await handler({ req: request(body, {}, undefined, "127.0.0.1") })).status).toBe(403)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("validates input and applies the selected operation's byte limit", async () => {
    const { handler, request } = fixture()
    const headers = { [operationExpectedRootsHeader]: projectRootHash("/server/project") }
    expect((await handler({ req: request({ operation: "test.echo", input: { text: 42 } }, headers) })).status).toBe(400)
    const input = { text: "x".repeat(70 * 1024) }
    expect((await handler({ req: request({ operation: "test.echo", input }) })).status).toBe(413)
    expect((await handler({ req: request({ operation: "test.large", input }) })).status).toBe(200)
    expect((await handler({ req: request({ operation: "test.large", input: { text: "x".repeat(130 * 1024) } }) })).status).toBe(413)
  })
})

describe("standalone operation installation", () => {
  it("publishes the listening address once and removes it on close", async () => {
    const root = await mkdtemp(join(import.meta.dirname, ".operations-discovery-"))
    try {
      const http = Object.assign(new EventEmitter(), {
        listening: false,
        address: () => ({ address: "127.0.0.1", family: "IPv4", port: 5179 }),
      })
      const server = {
        config: { root, base: "/portal/", server: {}, nitro: { handlers: [{ handler: join(root, ".vitehub/nitro/operations/rpc.mjs") }] } },
        httpServer: http, resolvedUrls: null,
      }
      publishStandaloneOperationServer(server)
      publishStandaloneOperationServer(server)
      expect(http.listenerCount("listening")).toBe(1)
      expect(readViteHubDevServerFile(root)).toBeUndefined()
      http.emit("listening")
      expect(findViteHubDevServerUrl([root], {})).toBe("http://127.0.0.1:5179/portal/")
      http.emit("close")
      expect(readViteHubDevServerFile(root)).toBeUndefined()
    }
    finally { await rm(root, { force: true, recursive: true }) }
  })

  it("signs loopback requests in the dev server that serves the transport", async () => {
    const root = await mkdtemp(join(import.meta.dirname, ".operations-install-"))
    try {
      vi.stubEnv(viteHubDevPeerKeyEnv, undefined)
      const { installStandaloneOperationRpc } = await import("../src/operations-vite.ts")
      const config = { root, plugins: [{ name: "kv", vitehub: { operations: [{ module: "@vite-hub/kv/operations" }] } }] }
      await installStandaloneOperationRpc(config, "serve", "@vite-hub/kv/operations")
      const nitro = Reflect.get(config, "nitro") as { devHandlers: Array<{ handler?: unknown }> }
      expect(nitro.devHandlers.map(entry => entry.handler)).toEqual([viteHubDevPeerDevHandler])
      // The worker that the dev server starts inherits the key of this process.
      expect(process.env[viteHubDevPeerKeyEnv]).toBe(useViteHubDevPeerKey())
    }
    finally { await rm(root, { force: true, recursive: true }) }
  })

  it.each(["build", "root-disabled", "console"])("leaves the transport absent when another policy owns it: %s", async (mode) => {
    const { installStandaloneOperationRpc } = await import("../src/operations-vite.ts")
    const config = { root: "/unused", plugins: mode === "build" ? [] : [{ name: mode === "console" ? "vite-hub/console" : "vite-hub/dependencies" }] }
    await installStandaloneOperationRpc(config, mode === "build" ? "build" : "serve", "@vite-hub/kv/operations")
    expect(Reflect.get(config, "nitro")).toBeUndefined()
  })
})
