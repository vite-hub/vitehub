import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createDrizzleWebhookEndpointStore, createDrizzleWebhookStore, webhooksTables } from "../src/database.ts"
import { allowMemberPairing, cancelMemberPairing, getMemberEndpoint, getMemberPairing, pairMemberEndpoint, refuseMemberPairing, startMemberPairing } from "../src/index.ts"
import { installWebhooks } from "../src/runtime.ts"

import type { Client } from "@libsql/client"

vi.mock("node:dns/promises", () => {
  const records: Record<string, string[]> = { "relay.t3.codes": ["104.21.3.218"], "intranet.example.com": ["10.0.0.7"] }
  const lookup = async (host: string) => {
    const addresses = records[host]
    if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" })
    return addresses.map(address => ({ address, family: 4 }))
  }
  return { lookup, default: { lookup } }
})

const relay = "https://relay.t3.codes/v1/hooks/key/hook/relay-token-7c1d"
const thread = "t3-thread://v2/6f5c40a4-eb77-4249-a83a-c0d4f680b208/thread-a"
let client: Client

beforeEach(async () => {
  vi.stubEnv("VITEHUB_WEBHOOKS_KEY", btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))))
  client = createClient({ url: ":memory:" })
  await client.executeMultiple(`${webhooksTables.join(";\n")};`)
  const db = drizzle({ client })
  installWebhooks({ webhooks: {}, store: createDrizzleWebhookStore(db), endpoints: createDrizzleWebhookEndpointStore(db) })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  client.close()
})

async function start(owner = "user_ana") {
  const [error, started] = await startMemberPairing(owner)
  if (error) throw error
  return started
}

describe("member pairing", () => {
  it("pairs and allows a receiver with the project-local development key", async () => {
    vi.stubEnv("VITEHUB_WEBHOOKS_KEY", undefined)
    const db = drizzle({ client })
    const developmentKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    installWebhooks({ webhooks: {}, store: createDrizzleWebhookStore(db), endpoints: createDrizzleWebhookEndpointStore(db), developmentKey })

    const { code } = await start()
    expect((await pairMemberEndpoint({ code, url: relay, thread }))[1]?.status).toBe("paired")
    expect((await allowMemberPairing("user_ana", code, { name: "T3 thread" }))[1]).toMatchObject({
      status: "allowed",
      endpoint: { address: thread, kind: "url" },
    })
  })

  it("pairs a T3 task, and Allow creates the endpoint with the thread as its address", async () => {
    const { code, secret, expiresAt } = await start()
    expect(code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/)
    expect(secret).toMatch(/^whsec_[0-9a-f]{64}$/)
    expect(expiresAt).toBeGreaterThan(Date.now())
    expect((await getMemberPairing("user_ana", code))[1]).toMatchObject({ state: "waiting", agent: null })

    const [, paired] = await pairMemberEndpoint({ code, url: relay, thread })
    expect(paired).toEqual({ status: "paired", pairing: expect.objectContaining({ state: "paired", agent: "t3", host: "relay.t3.codes", address: thread }) })
    expect(await pairMemberEndpoint({ code, url: relay })).toEqual([undefined, { status: "used" }])

    const [, allowed] = await allowMemberPairing("user_ana", code, { name: pairing => `${pairing.agent} thread`, ownerName: "Ana" })
    expect(allowed).toMatchObject({ status: "allowed", endpoint: { owner: "user_ana", ownerName: "Ana", name: "t3 thread", kind: "url", host: "relay.t3.codes", address: thread } })
    expect((await getMemberEndpoint("user_ana", { address: thread }))[1]?.address).toBe(thread)
    expect(await allowMemberPairing("user_ana", code, { name: "again" })).toEqual([undefined, { status: "expired" }])
    const stored = JSON.stringify((await client.execute("SELECT * FROM vitehub_webhook_pairings")).rows)
    for (const value of [code, secret, "relay-token-7c1d"]) expect(stored).not.toContain(value)
  })

  it("pairs an inbox, and drops a thread link that is not a T3 one", async () => {
    const inbox = await start("user_mei")
    expect((await pairMemberEndpoint({ code: inbox.code, inbox: "Codex" }))[1]).toMatchObject({ status: "paired", pairing: { agent: "codex", host: null } })
    expect((await allowMemberPairing("user_mei", inbox.code, { name: "Codex inbox" }))[1]).toMatchObject({ status: "allowed", endpoint: { kind: "inbox", agent: "codex", address: null } })

    const other = await start()
    expect((await pairMemberEndpoint({ code: other.code, url: relay, thread: "javascript:alert(1)" }))[1]).toMatchObject({ status: "paired", pairing: { address: null } })
  })

  it("rejects unsupported inbox names without consuming a waiting code", async () => {
    const { code } = await start()
    for (const inbox of ["Cursor", "constructor", "__proto__"]) {
      expect((await pairMemberEndpoint({ code, inbox }))[0]).toMatchObject({ code: "WEBHOOKS_ENDPOINT_INVALID" })
    }
    expect((await pairMemberEndpoint({ code, inbox: "Claude Code" }))[1]).toMatchObject({ status: "paired", pairing: { agent: "claude-code" } })
  })

  it("refuses Allow by another member, a URL that is not safe, a used-up code, and a code past 10 minutes", async () => {
    const mine = await start()
    await pairMemberEndpoint({ code: mine.code, url: relay })
    expect(await allowMemberPairing("user_bob", mine.code, { name: "x" })).toEqual([undefined, { status: "not-owner" }])
    expect(await getMemberPairing("user_bob", mine.code)).toEqual([undefined, null])
    expect(await getMemberEndpoint("user_bob")).toEqual([undefined, null])

    const unsafe = await start()
    const [, refused] = await pairMemberEndpoint({ code: unsafe.code, url: "https://intranet.example.com/hook" }, { hosts: ["intranet.example.com"] })
    expect(refused).toMatchObject({ status: "refused", reason: expect.stringContaining("private") })
    expect(await pairMemberEndpoint({ code: unsafe.code, url: relay })).toEqual([undefined, { status: "used" }])

    const leaked = await start()
    expect(await refuseMemberPairing(leaked.code)).toEqual([undefined, true])
    expect((await getMemberPairing("user_ana", leaked.code))[1]?.state).toBe("refused")

    const late = await start()
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(late.expiresAt + 1)
    expect(await pairMemberEndpoint({ code: late.code, url: relay })).toEqual([undefined, { status: "expired" }])
  })

  it("cancels only the owner's code, and refuses input of neither shape", async () => {
    const { code } = await start()
    await cancelMemberPairing("user_bob", code)
    expect((await getMemberPairing("user_ana", code))[1]).not.toBeNull()
    await cancelMemberPairing("user_ana", code)
    expect(await getMemberPairing("user_ana", code)).toEqual([undefined, null])
    for (const input of [{ code }, { code, url: relay, inbox: "Codex" }, { code, inbox: "Cursor" }, { url: relay }]) {
      expect((await pairMemberEndpoint(input))[0]).toMatchObject({ code: "WEBHOOKS_ENDPOINT_INVALID" })
    }
  })
})
