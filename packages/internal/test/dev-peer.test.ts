import { beforeEach, describe, expect, it, vi } from "vitest"

type DevPeer = typeof import("../src/dev-peer.ts")

let peer: DevPeer

// Each test gets a new process key and new nonce memory.
beforeEach(async () => {
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.dev-peer"))
  vi.resetModules()
  vi.unstubAllEnvs()
  peer = await import("../src/dev-peer.ts")
})

const key = "k".repeat(43)
const url = "http://localhost:3000/_vitehub/rpc/__call"

function request(evidence: string | undefined, init: { method?: string, url?: string } = {}): Request {
  return new Request(init.url ?? url, { headers: evidence === undefined ? {} : { [peer.viteHubDevPeerHeader]: evidence }, method: init.method ?? "POST" })
}

function nodeEvent(remoteAddress: string | undefined, headers: Record<string, string> = {}, path = "/_vitehub/rpc/__call") {
  return { node: { req: { headers: { ...headers }, method: "POST", socket: { remoteAddress }, url: path } } }
}

function webEvent(remoteAddress: string | undefined, headers: Record<string, string> = {}, path = "/_vitehub/rpc/__call") {
  const node = { headers: { ...headers }, method: "POST", socket: { remoteAddress }, url: path }
  return { node, event: { req: new Request(`http://localhost:3000${path}`, { headers, method: "POST" }), runtime: { node: { req: node } } } }
}

describe("dev peer evidence", () => {
  it("accepts evidence for the same method and path", async () => {
    const evidence = await peer.signViteHubDevPeer(key, { method: "POST", path: "/_vitehub/rpc/__call?x=1" })
    await expect(peer.verifyViteHubDevPeer(request(evidence), key)).resolves.toBe(true)
  })

  it("refuses missing, malformed, and tampered evidence", async () => {
    const evidence = await peer.signViteHubDevPeer(key, { method: "POST", path: "/_vitehub/rpc/__call" })
    const [version, timestamp, nonce, signature] = evidence.split(".") as [string, string, string, string]
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    const flip = (value: string) => `${value.slice(0, -2)}${value.at(-2) === "A" ? "B" : "A"}${value.at(-1)}`
    for (const forged of [
      undefined,
      "",
      "1",
      "true",
      "127.0.0.1",
      `${version}.${timestamp}.${nonce}`,
      `v2.${timestamp}.${nonce}.${signature}`,
      `${version}.${timestamp}.${nonce}.${flip(signature)}`,
      `${version}.${timestamp}.${flip(nonce)}.${signature}`,
      `${version}.${Number(timestamp) - 1}.${nonce}.${signature}`,
      `${version}.${timestamp}.${nonce}.${signature}=`,
      `${version}.${timestamp}.${nonce}.${signature}, ${evidence}`,
      // The last base64url character of a 32-byte value has 2 unused bits. Another value for them is not the evidence.
      `${version}.${timestamp}.${nonce}.${signature.slice(0, -1)}${alphabet[alphabet.indexOf(signature.at(-1) ?? "") + 1]}`,
      `${evidence}.`,
    ]) await expect(peer.verifyViteHubDevPeer(request(forged), key), String(forged)).resolves.toBe(false)
    // The untouched evidence still works, so each refusal above came from its own change.
    await expect(peer.verifyViteHubDevPeer(request(evidence), key)).resolves.toBe(true)
  })

  it("refuses evidence for another key, method, or path", async () => {
    const evidence = () => peer.signViteHubDevPeer(key, { method: "POST", path: "/_vitehub/rpc/__call" })
    await expect(peer.verifyViteHubDevPeer(request(await evidence()), "x".repeat(43))).resolves.toBe(false)
    await expect(peer.verifyViteHubDevPeer(request(await evidence(), { method: "PUT" }), key)).resolves.toBe(false)
    await expect(peer.verifyViteHubDevPeer(request(await evidence(), { url: "http://localhost:3000/_vitehub/mcp" }), key)).resolves.toBe(false)
    await expect(peer.verifyViteHubDevPeer(request(await evidence(), { url: "http://localhost:3000/app/_vitehub/rpc/__call" }), key)).resolves.toBe(false)
    // A protocol-relative request target keeps its own path.
    const relative = await peer.signViteHubDevPeer(key, { method: "POST", path: "//attacker.example/_vitehub/rpc/__call" })
    await expect(peer.verifyViteHubDevPeer(request(relative), key)).resolves.toBe(false)
  })

  it("refuses expired and future evidence", async () => {
    const now = Date.now()
    const old = await peer.signViteHubDevPeer(key, { method: "POST", path: "/_vitehub/rpc/__call" }, now - peer.viteHubDevPeerMaxAgeMs - 1)
    await expect(peer.verifyViteHubDevPeer(request(old), key, now)).resolves.toBe(false)
    const future = await peer.signViteHubDevPeer(key, { method: "POST", path: "/_vitehub/rpc/__call" }, now + 10_000)
    await expect(peer.verifyViteHubDevPeer(request(future), key, now)).resolves.toBe(false)
    const fresh = await peer.signViteHubDevPeer(key, { method: "POST", path: "/_vitehub/rpc/__call" }, now - peer.viteHubDevPeerMaxAgeMs + 1_000)
    await expect(peer.verifyViteHubDevPeer(request(fresh), key, now)).resolves.toBe(true)
  })

  it("accepts each piece of evidence for one request only", async () => {
    const evidence = await peer.signViteHubDevPeer(key, { method: "POST", path: "/_vitehub/rpc/__call" })
    const first = request(evidence)
    await expect(peer.verifyViteHubDevPeer(first, key)).resolves.toBe(true)
    // The Console can check one request twice.
    await expect(peer.verifyViteHubDevPeer(first, key)).resolves.toBe(true)
    await expect(peer.verifyViteHubDevPeer(request(evidence), key)).resolves.toBe(false)
    // Two concurrent replays cannot both pass the async signature check.
    const again = await peer.signViteHubDevPeer(key, { method: "POST", path: "/_vitehub/rpc/__call" })
    const results = await Promise.all([peer.verifyViteHubDevPeer(request(again), key), peer.verifyViteHubDevPeer(request(again), key)])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it("tells loopback socket addresses from others", () => {
    for (const address of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "::FFFF:127.0.0.1"]) expect(peer.isViteHubLoopbackAddress(address), address).toBe(true)
    for (const address of [undefined, "", "0.0.0.0", "::", "192.168.0.38", "100.88.128.32", "::ffff:192.168.0.38", "1127.0.0.1", "127.0.0.1.attacker.example", "127.0.0.1, 203.0.113.9", "localhost", "fe80::1"]) expect(peer.isViteHubLoopbackAddress(address), String(address)).toBe(false)
  })
})

describe("dev peer key", () => {
  it("creates one fresh key for each process and gives it to workers through the environment", () => {
    vi.stubEnv(peer.viteHubDevPeerKeyEnv, "inherited-from-a-parent-process-or-a-shell")
    expect(peer.readViteHubDevPeerKey()).toBe("inherited-from-a-parent-process-or-a-shell")
    const created = peer.useViteHubDevPeerKey()
    expect(created).toMatch(/^[\w-]{43}$/)
    expect(created).not.toBe("inherited-from-a-parent-process-or-a-shell")
    expect(process.env[peer.viteHubDevPeerKeyEnv]).toBe(created)
    expect(peer.useViteHubDevPeerKey()).toBe(created)
    expect(peer.readViteHubDevPeerKey()).toBe(created)
  })

  it("reads no key from a worker without one, or with a short one", () => {
    vi.stubEnv(peer.viteHubDevPeerKeyEnv, undefined)
    expect(peer.readViteHubDevPeerKey()).toBeUndefined()
    vi.stubEnv(peer.viteHubDevPeerKeyEnv, "")
    expect(peer.readViteHubDevPeerKey()).toBeUndefined()
    vi.stubEnv(peer.viteHubDevPeerKeyEnv, "short")
    expect(peer.readViteHubDevPeerKey()).toBeUndefined()
  })
})

describe("dev peer dev handler", () => {
  it("signs a loopback request of H3 1 and replaces a client copy", async () => {
    const event = nodeEvent("127.0.0.1", { [peer.viteHubDevPeerHeader]: "v1.forged" })
    await expect(peer.viteHubDevPeerDevHandler(event)).resolves.toBeUndefined()
    const evidence = event.node.req.headers[peer.viteHubDevPeerHeader]
    expect(evidence).not.toBe("v1.forged")
    await expect(peer.verifyViteHubDevPeer(request(evidence), peer.useViteHubDevPeerKey())).resolves.toBe(true)
  })

  it("signs a loopback request of H3 2 in the Node request and the Web request", async () => {
    const { event, node } = webEvent("::ffff:127.0.0.1", { [peer.viteHubDevPeerHeader]: "v1.forged" })
    await peer.viteHubDevPeerDevHandler(event)
    const evidence = event.req.headers.get(peer.viteHubDevPeerHeader)
    expect(evidence).not.toBe("v1.forged")
    expect(node.headers[peer.viteHubDevPeerHeader]).toBe(evidence)
    await expect(peer.verifyViteHubDevPeer(request(evidence ?? undefined), peer.useViteHubDevPeerKey())).resolves.toBe(true)
  })

  it("strips client evidence from a remote or unknown peer and adds none", async () => {
    const forged = await peer.signViteHubDevPeer(peer.useViteHubDevPeerKey(), { method: "POST", path: "/_vitehub/rpc/__call" })
    for (const address of ["192.168.0.38", "203.0.113.9", "::ffff:10.0.0.1", undefined]) {
      // A remote client also sends the headers that a proxy would add for a local peer.
      const headers = { host: "localhost", [peer.viteHubDevPeerHeader]: forged, "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" }
      const v1 = nodeEvent(address, headers)
      await peer.viteHubDevPeerDevHandler(v1)
      expect(v1.node.req.headers, String(address)).not.toHaveProperty(peer.viteHubDevPeerHeader)
      const v2 = webEvent(address, headers)
      await peer.viteHubDevPeerDevHandler(v2.event)
      expect(v2.event.req.headers.has(peer.viteHubDevPeerHeader), String(address)).toBe(false)
      expect(v2.node.headers, String(address)).not.toHaveProperty(peer.viteHubDevPeerHeader)
    }
  })

  it("signs no request target that is not a path", async () => {
    const event = nodeEvent("127.0.0.1", {}, "http://attacker.example/_vitehub/rpc/__call")
    await peer.viteHubDevPeerDevHandler(event)
    expect(event.node.req.headers).not.toHaveProperty(peer.viteHubDevPeerHeader)
  })

  it("goes first in Nitro dev handlers once, and creates the key", () => {
    vi.stubEnv(peer.viteHubDevPeerKeyEnv, undefined)
    const other = { handler: () => undefined }
    const handlers: Array<{ handler?: unknown, route?: string }> = [other]
    peer.addViteHubDevPeerDevHandler(handlers)
    peer.addViteHubDevPeerDevHandler(handlers)
    expect(handlers).toHaveLength(2)
    expect(handlers[0]?.handler).toBe(peer.viteHubDevPeerDevHandler)
    expect(handlers[0]).not.toHaveProperty("route")
    expect(handlers[1]).toBe(other)
    expect(peer.readViteHubDevPeerKey()).toBe(peer.useViteHubDevPeerKey())
  })
})
