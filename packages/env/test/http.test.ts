import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createEnvBridge, type EnvAccessContext } from "../src/bridge.ts"
import { createDatabaseEnvStore } from "../src/database.ts"
import { createEnvBridgeHandler } from "../src/http.ts"

const origin = "https://console.example"
const admin: EnvAccessContext = { actor: { kind: "user", id: "owner" }, admin: true }
const agent: EnvAccessContext = { actor: { kind: "agent", id: "reviewer" } }
const key = "private/provider/github"
const path = "github.token"
const secret = "ghp_synthetic_secret_1234"
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})

function request(input: unknown, headers: NonNullable<ConstructorParameters<typeof Request>[1]>["headers"] = { origin }): Request {
  return new Request(`${origin}/_vitehub/env/manage`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  })
}

function setup(context: EnvAccessContext | null = admin) {
  const client = createClient({ url: ":memory:" })
  cleanup.push(() => client.close())
  const store = createDatabaseEnvStore({
    db: drizzle(client),
    encryptionKey: new Uint8Array(32).fill(9),
    previews: true,
  })
  const bridge = createEnvBridge({ ...store, runtimeContext: () => admin })
  const authenticate = vi.fn(async (_request: Request) => context)
  const resolve = vi.fn((requested: string) =>
    requested === path ? { key, management: { bridge, authenticate } } : undefined,
  )
  return { bridge, authenticate, resolve, handler: createEnvBridgeHandler(resolve) }
}

describe("Env management HTTP", () => {
  it("requires authentication and preserves the original request headers", async () => {
    const { handler, authenticate } = setup(null)
    const input = request(
      { path, action: "inspect", admin: true, actor: admin.actor },
      { origin, cookie: "session=invalid" },
    )
    const response = await handler(input)
    expect(response.status).toBe(401)
    expect(authenticate).toHaveBeenCalledWith(input)
    expect(authenticate.mock.calls[0]?.[0].headers.get("cookie")).toBe("session=invalid")
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("ignores client-supplied identity and scope when authorizing mutations", async () => {
    const { handler, bridge } = setup(agent)
    const response = await handler(
      request({
        path,
        action: "replace",
        value: secret,
        expectedRevision: null,
        actor: admin.actor,
        admin: true,
        scope: [{ key, permissions: ["replace"] }],
      }),
    )
    expect(response.status).toBe(403)
    expect(await bridge.inspect(admin, key)).toBeUndefined()
    const denied = (await bridge.activity(admin, key)).find((event) => event.outcome === "denied")
    expect(denied?.actor).toEqual(agent.actor)
  })

  it("enforces the verified token scope even for an administrative identity", async () => {
    const { handler, bridge } = setup({ ...admin, scope: [{ key, permissions: ["inspect"] }] })
    await bridge.replace(admin, { key, value: secret, expectedRevision: null })
    const inspected = await handler(request({ path, action: "inspect" }))
    expect(await inspected.json()).toMatchObject({ permissions: ["inspect"], admin: false })
    expect((await handler(request({ path, action: "preview", scope: undefined }))).status).toBe(
      403,
    )
    expect((await handler(request({ path, action: "grants" }))).status).toBe(403)
  })

  it("rejects cross-origin and unproven browser requests before resolving or authenticating", async () => {
    const { handler, resolve, authenticate } = setup()
    for (const headers of [
      { origin: "https://attacker.example" },
      {},
      { authorization: "Basic invalid" },
      { origin: "null" },
      { origin: "https://attacker.example", authorization: "Bearer valid" },
    ]) {
      expect((await handler(request({ path, action: "inspect" }, headers))).status).toBe(403)
    }
    expect(resolve).not.toHaveBeenCalled()
    expect(authenticate).not.toHaveBeenCalled()
    expect((await handler(new Request(`${origin}/_vitehub/env/manage`))).status).toBe(405)
  })

  it("passes bearer credentials to authentication without granting authority itself", async () => {
    const { handler, authenticate } = setup(null)
    const input = request({ path, action: "inspect" }, { authorization: "Bearer invalid" })
    expect((await handler(input)).status).toBe(401)
    expect(authenticate).toHaveBeenCalledWith(input)
    authenticate.mockResolvedValue(admin)
    expect(
      (await handler(request({ path, action: "inspect" }, { authorization: "Bearer verified" })))
        .status,
    ).toBe(200)
  })

  it("only resolves declared paths and ignores client-supplied storage keys", async () => {
    const { handler, bridge, authenticate } = setup()
    await bridge.replace(admin, { key: "unlisted", value: "private", expectedRevision: null })
    for (const requested of [key, "unlisted", "process.env", "__proto__"]) {
      expect((await handler(request({ path: requested, action: "inspect" }))).status).toBe(404)
    }
    expect(authenticate).not.toHaveBeenCalled()
    expect(
      (
        await handler(
          request({
            path,
            key: "unlisted",
            action: "replace",
            value: secret,
            expectedRevision: null,
          }),
        )
      ).status,
    ).toBe(200)
    expect(await bridge.read({ env: {}, keys: [key, "unlisted"] })).toEqual({
      [key]: secret,
      unlisted: "private",
    })
  })

  it("returns metadata and explicit previews without exposing plaintext or a read endpoint", async () => {
    const { handler, bridge } = setup()
    const replacement = await handler(
      request({ path, action: "replace", value: secret, expectedRevision: null }),
    )
    expect(replacement.status).toBe(200)
    expect(await replacement.json()).toEqual({
      revision: expect.any(String),
      updatedAt: expect.any(String),
      activation: "next-resolution",
    })
    for (const action of ["inspect", "preview", "activity", "grants"]) {
      const response = await handler(request({ path, action }))
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("no-store")
      const text = await response.text()
      expect(text).not.toContain(secret)
      if (action === "preview") expect(text).toContain("ghp_••••1234")
      if (action === "inspect") expect(text).not.toContain("ghp_")
    }
    for (const action of ["read", "resolve", "use"])
      expect((await handler(request({ path, action }))).status).toBe(400)
    expect(
      (await handler(request({ path, action: "replace", value: "stale", expectedRevision: null })))
        .status,
    ).toBe(409)
    expect(await bridge.read({ env: {}, keys: [key] })).toEqual({ [key]: secret })
  })

  it("validates malformed JSON, action arguments and paths before mutation", async () => {
    const { handler, bridge } = setup()
    for (const input of [
      null,
      [],
      {},
      { path: 42 },
      { path: "x".repeat(257) },
      { path, action: "unknown" },
      { path, action: "replace", value: secret },
      { path, action: "replace", value: 42, expectedRevision: null },
      { path, action: "activity", before: 42 },
      { path, action: "grant", actor: agent.actor, permissions: ["admin"] },
      { path, action: "grant", actor: { kind: "root", id: "owner" }, permissions: ["use"] },
    ]) {
      expect((await handler(request(input))).status).toBe(400)
    }
    expect(
      (
        await handler(
          new Request(`${origin}/_vitehub/env/manage`, {
            method: "POST",
            headers: { origin },
            body: "{",
          }),
        )
      ).status,
    ).toBe(400)
    expect(await bridge.inspect(admin, key)).toBeUndefined()
  })

  it("limits actual streamed bytes without relying on content-length", async () => {
    const { handler, resolve } = setup()
    const oversized = request(
      { path, action: "replace", value: "é".repeat(33_000), expectedRevision: null },
      { origin, "content-length": "1" },
    )
    expect((await handler(oversized)).status).toBe(400)
    expect(resolve).not.toHaveBeenCalled()
  })

  it("supports exact grants and revocation without accepting a different target key", async () => {
    const { handler, bridge } = setup()
    expect(
      (
        await handler(
          request({
            path,
            action: "grant",
            actor: agent.actor,
            key: "other",
            permissions: ["inspect"],
          }),
        )
      ).status,
    ).toBe(200)
    expect(await bridge.permissions(agent, key)).toEqual(["inspect"])
    expect(await bridge.permissions(agent, "other")).toEqual([])
    expect((await handler(request({ path, action: "revoke", actor: agent.actor }))).status).toBe(
      200,
    )
    expect(await bridge.permissions(agent, key)).toEqual([])
  })

  it("sanitizes authentication failures and never returns their sensitive details", async () => {
    const { handler, authenticate } = setup()
    authenticate.mockRejectedValue(new Error(`Upstream rejected ${secret}`))
    const response = await handler(request({ path, action: "inspect" }))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      code: "ENV_BRIDGE_OPERATION_FAILED",
      message: "Env operation failed.",
    })
  })
})

it("discovers preview-only permissions without requiring inspect or reading metadata", async () => {
  const { bridge, handler } = setup(agent)
  await bridge.replace(admin, { key, value: secret, expectedRevision: null })
  await bridge.grant(admin, { key, actor: agent.actor, permissions: ["preview"] })
  const inspect = vi.spyOn(bridge, "inspect")
  const result = await handler(request({ path, action: "permissions" }))
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({ permissions: ["preview"], admin: false })
  expect(inspect).not.toHaveBeenCalled()
  expect((await handler(request({ path, action: "inspect" }))).status).toBe(403)
  const preview = await handler(request({ path, action: "preview" }))
  expect(await preview.json()).toEqual({ metadata: { preview: "ghp_••••1234" } })
})


it("rejects malformed grant targets before they can poison durable activity", async () => {
  const { bridge, handler } = setup()
  await bridge.replace(admin, { key, value: secret, expectedRevision: null })
  const before = await bridge.activity(admin, key)
  for (const action of ["grant", "revoke"]) {
    for (const id of ["", "x".repeat(513), "invalid\nactor"]) {
      const response = await handler(request({ path, action, actor: { kind: "agent", id }, permissions: ["use"] }))
      expect(response.status).toBe(400)
    }
  }
  expect((await handler(request({ path, action: "grant", actor: agent.actor, permissions: [] }))).status).toBe(400)
  expect(await bridge.activity(admin, key)).toEqual(before)
  expect((await handler(request({ path, action: "activity" }))).status).toBe(200)
})
