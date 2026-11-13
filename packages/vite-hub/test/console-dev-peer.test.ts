import * as v from "valibot"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defineOperation } from "@vite-hub/internal/operations"
import { addViteHubDevPeerDevHandler, signViteHubDevPeer, useViteHubDevPeerKey, viteHubDevPeerDevHandler, viteHubDevPeerHeader, viteHubDevPeerKeyEnv } from "@vite-hub/internal/dev-peer"

import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleDevelopment } from "../src/console/runtime/server/development.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"
import { operationRpcBody } from "../../internal/test-utils/operation-rpc.ts"

const greet = defineOperation({
  description: "Greet someone.",
  input: v.strictObject({ name: v.string() }),
  kind: "read",
  name: "fixture.greet",
  run: ({ name }) => ({ greeting: `Hello ${name}` }),
  section: "fixture",
})

const rpcPath = "/_vitehub/rpc"
const remote = "192.168.0.38"
// What a remote client sends to look local: the dev server's own Host, and the proxy headers of a local peer.
const forgedLocal = { "host": "localhost:3000", "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "localhost:3000", "x-real-ip": "127.0.0.1" }

/** Run the front process's dev handler on a Node request, and return the headers that its proxy forwards. */
async function throughFront(remoteAddress: string | undefined, headers: Record<string, string> = {}, path = rpcPath): Promise<Record<string, string>> {
  const req = { headers: { host: "localhost:3000", ...headers }, method: "POST", socket: { remoteAddress }, url: path }
  await viteHubDevPeerDevHandler({ runtime: { node: { req } } })
  return Object.fromEntries(Object.entries(req.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

/** The Console RPC in the worker. Behind the front process's Unix-socket proxy, the worker sees no peer address. */
function rpc(headers: Record<string, string>, remoteAddress?: string, path = rpcPath) {
  return handleConsoleRpcRequest(new Request(`http://localhost:3000${path}`, {
    body: operationRpcBody("fixture.greet", { name: "Ada" }),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1", ...headers },
    method: "POST",
  }), { remoteAddress })
}

beforeEach(() => {
  installConsoleOperations([{ operations: [greet], plugin: "fixture-plugin" }])
  installConsoleSections("/work/app", ["fixture"])
  installConsoleDevelopment("/work/app", true)
  // The front process creates the key before its worker starts, and the worker inherits it.
  useViteHubDevPeerKey()
})

afterEach(() => {
  vi.unstubAllEnvs()
  Reflect.deleteProperty(process.env, viteHubDevPeerKeyEnv)
  installConsoleDevelopment("/work/app", false)
  installConsoleAccess({ mode: "open" })
  installConsoleOperations([])
})

describe.each(["local", "open"] as const)("the %s development Console behind a dev worker proxy", (mode) => {
  beforeEach(() => installConsoleAccess({ mode }))

  it("serves a loopback peer that the front process signed", async () => {
    expect((await rpc(await throughFront("127.0.0.1"))).status).toBe(200)
    expect((await rpc(await throughFront("::1"))).status).toBe(200)
    expect((await rpc(await throughFront("::ffff:127.0.0.1"))).status).toBe(200)
  })

  it("refuses a remote peer that sends Host: localhost and x-forwarded-for: 127.0.0.1", async () => {
    const response = await rpc(await throughFront(remote, forgedLocal))
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: "CONSOLE_LOOPBACK_ONLY", fix: expect.stringContaining("console.auth"), ok: false })
    // A Unix socket or another proxy in front gives the front process no address either.
    expect((await rpc(await throughFront(undefined, forgedLocal))).status).toBe(403)
  })

  it("strips evidence that a client sends, even valid evidence", async () => {
    // A client that somehow holds fresh evidence, for example from a log, still cannot pass it through.
    const stolen = await signViteHubDevPeer(useViteHubDevPeerKey(), { method: "POST", path: rpcPath })
    const forwarded = await throughFront(remote, { ...forgedLocal, [viteHubDevPeerHeader]: stolen })
    expect(forwarded).not.toHaveProperty(viteHubDevPeerHeader)
    expect((await rpc(forwarded)).status).toBe(403)
  })

  it("refuses replayed and tampered evidence", async () => {
    const headers = await throughFront("127.0.0.1")
    expect((await rpc(headers)).status).toBe(200)
    expect((await rpc(headers)).status).toBe(403)
    const fresh = await throughFront("127.0.0.1")
    const evidence = fresh[viteHubDevPeerHeader] ?? ""
    const tampered = `${evidence.slice(0, -2)}${evidence.at(-2) === "A" ? "B" : "A"}${evidence.at(-1)}`
    expect((await rpc({ ...fresh, [viteHubDevPeerHeader]: tampered })).status).toBe(403)
    // Evidence for another path, or signed with another key, is refused too.
    expect((await rpc(await throughFront("127.0.0.1", {}, "/_vitehub/mcp"))).status).toBe(403)
    const otherKey = await signViteHubDevPeer("x".repeat(43), { method: "POST", path: rpcPath })
    expect((await rpc({ [viteHubDevPeerHeader]: otherKey })).status).toBe(403)
  })

  it("refuses evidence without the dev server's Host", async () => {
    expect((await rpc(await throughFront("127.0.0.1", { host: "attacker.example" }))).status).toBe(403)
    expect((await rpc(await throughFront("127.0.0.1", { "x-forwarded-host": "abc.trycloudflare.com" }))).status).toBe(403)
  })

  it("refuses a tunnel or a proxy on this machine, which connects from 127.0.0.1", async () => {
    // A TCP forwarder that adds `x-forwarded-for` for the client it forwards, as the reviewer's probe did.
    const response = await rpc(await throughFront("127.0.0.1", { "x-forwarded-for": "203.0.113.9" }))
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: "CONSOLE_LOOPBACK_ONLY" })
    const forwarders: Array<Record<string, string>> = [{ "cf-connecting-ip": "203.0.113.9", "cf-ray": "9a0b1c2d3e4f5a6b-MAD" }, { forwarded: "for=203.0.113.9" }, { "tailscale-user-login": "alice@example.com" }, { "x-real-ip": "203.0.113.9" }]
    for (const headers of forwarders) {
      expect((await rpc(await throughFront("127.0.0.1", headers))).status, JSON.stringify(headers)).toBe(403)
    }
  })

  it("trusts only the evidence when the worker has a key, not its own peer address", async () => {
    // A worker that its front process reaches over TCP on 127.0.0.1 sees that address for every client.
    expect((await rpc(await throughFront(remote, forgedLocal), "127.0.0.1")).status).toBe(403)
    // A known remote address wins over evidence.
    expect((await rpc(await throughFront("127.0.0.1"), "203.0.113.9")).status).toBe(403)
  })
})

describe("the development Console without a front process", () => {
  beforeEach(() => {
    installConsoleAccess({ mode: "local" })
    vi.stubEnv(viteHubDevPeerKeyEnv, undefined)
  })

  it("decides by the peer address that plain vite dev reports", async () => {
    expect((await rpc({}, "127.0.0.1")).status).toBe(200)
    expect((await rpc(forgedLocal, remote)).status).toBe(403)
  })

  it("refuses an unknown peer, and ignores evidence that nothing can check", async () => {
    expect((await rpc(forgedLocal)).status).toBe(403)
    const evidence = await signViteHubDevPeer(useViteHubDevPeerKey(), { method: "POST", path: rpcPath })
    vi.stubEnv(viteHubDevPeerKeyEnv, undefined)
    expect((await rpc({ [viteHubDevPeerHeader]: evidence })).status).toBe(403)
  })
})

describe("a production Console", () => {
  it("never trusts the evidence header", async () => {
    installConsoleDevelopment("/work/app", false)
    installConsoleAccess({ mode: "local" })
    const response = await rpc(await throughFront("127.0.0.1"), "127.0.0.1")
    expect(response.status).not.toBe(200)
  })

  it("adds the front dev handler only to a development Nitro", async () => {
    const plugin = consoleVitePlugin({ console: { auth: false } })
    const setup = (dev: boolean) => {
      const devHandlers: Array<{ handler?: unknown, route?: string }> = []
      // SAFETY: The Console's Nitro module reads only these options.
      plugin.nitro?.setup?.({ options: { dev, devHandlers } } as never)
      return devHandlers
    }
    expect(setup(false)).toEqual([])
    expect(setup(true).map(entry => entry.handler)).toEqual([viteHubDevPeerDevHandler])
    const handlers = [{ handler: () => undefined }]
    addViteHubDevPeerDevHandler(handlers)
    expect(handlers[0]?.handler).toBe(viteHubDevPeerDevHandler)
  })
})
