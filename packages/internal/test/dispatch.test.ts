import { describe, expect, it } from "vitest"

import { hasViteHubDispatch, resolveViteHubDispatchKey, signViteHubDispatch, verifyViteHubDispatch, viteHubDispatchHeaders } from "../src/dispatch.ts"

const env = { VITEHUB_SECRET: "s".repeat(44) }
const body = JSON.stringify({ name: "morning-brief" })
const operation = "schedule.run"

async function signed(overrides: { actor?: string, now?: number } = {}): Promise<Headers> {
  const key = await resolveViteHubDispatchKey(env)
  return new Headers(await signViteHubDispatch({ actor: "maxi", body, key: key!, operation, ...overrides }))
}

describe("dispatch", () => {
  it("resolves the same key from the root secret and from VITEHUB_DISPATCH_KEY", async () => {
    const key = await resolveViteHubDispatchKey(env)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    await expect(resolveViteHubDispatchKey({ VITEHUB_DISPATCH_KEY: key })).resolves.toBe(key)
    await expect(resolveViteHubDispatchKey({})).resolves.toBeUndefined()
    await expect(resolveViteHubDispatchKey({ VITEHUB_DISPATCH_KEY: "nope" })).rejects.toThrow(/64-character/)
  })

  it("accepts a signed request once and returns the actor claim", async () => {
    const headers = await signed()
    expect(hasViteHubDispatch(headers)).toBe(true)
    await expect(verifyViteHubDispatch({ body, env, headers, operation })).resolves.toEqual({ actor: "maxi", ok: true })
    await expect(verifyViteHubDispatch({ body, env, headers, operation })).resolves.toMatchObject({ message: "Dispatch nonce was already used.", ok: false })
  })

  it("rejects a changed body, operation, or actor", async () => {
    await expect(verifyViteHubDispatch({ body: `${body} `, env, headers: await signed(), operation })).resolves.toMatchObject({ ok: false, status: 401 })
    await expect(verifyViteHubDispatch({ body, env, headers: await signed(), operation: "agent.invoke" })).resolves.toMatchObject({ ok: false })
    const headers = await signed()
    headers.set(viteHubDispatchHeaders.actor, "someone-else")
    await expect(verifyViteHubDispatch({ body, env, headers, operation })).resolves.toMatchObject({ ok: false })
  })

  it("rejects an expired request, another deployment's key, and a deployment without a root secret", async () => {
    await expect(verifyViteHubDispatch({ body, env, headers: await signed({ now: Date.now() - 600_000 }), operation })).resolves.toMatchObject({ message: expect.stringMatching(/expired/) })
    await expect(verifyViteHubDispatch({ body, env: { VITEHUB_SECRET: "o".repeat(44) }, headers: await signed(), operation })).resolves.toMatchObject({ message: expect.stringMatching(/does not match/) })
    await expect(verifyViteHubDispatch({ body, env: {}, headers: await signed(), operation })).resolves.toMatchObject({ message: expect.stringMatching(/Set VITEHUB_SECRET/) })
  })

  it("rejects malformed headers and control characters in the actor", async () => {
    const headers = await signed()
    headers.set(viteHubDispatchHeaders.signature, "v2=abc")
    await expect(verifyViteHubDispatch({ body, env, headers, operation })).resolves.toMatchObject({ message: "Malformed dispatch signature." })
    const forged = await signed()
    forged.set(viteHubDispatchHeaders.actor, "maxi\tadmin")
    await expect(verifyViteHubDispatch({ body, env, headers: forged, operation })).resolves.toMatchObject({ message: "Malformed dispatch signature." })
  })
})
