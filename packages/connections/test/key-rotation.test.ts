import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, expect, it, vi } from "vitest"

vi.mock("#vitehub/connections/registry", () => ({ default: {}, activityRetention: undefined, database: undefined, docs: undefined }))

import { runConnectionsCli } from "../src/cli.ts"
import { createConnectionsHandler } from "../src/http.ts"
import { getConnectionsRuntime, installConnectionsRegistry } from "../src/runtime/state.ts"
import { createDatabaseConnectionStore } from "../src/store.ts"

const keyA = Buffer.alloc(32, 1)
const keyB = Buffer.alloc(32, 2)

afterEach(() => {
  vi.unstubAllEnvs()
})

function useDatabase(db: ReturnType<typeof drizzle>) {
  installConnectionsRegistry({ activityRetention: false, database: async () => db, default: {}, docs: undefined })
}

it("rotates stored tokens to the first key of VITEHUB_CONNECTIONS_KEYS with the CLI", async () => {
  const client = createClient({ url: ":memory:" })
  try {
    const db = drizzle({ client })
    const old = createDatabaseConnectionStore({ db, encryptionKeys: [keyA] })
    const written = await old.secrets.replace({ key: "connection/mail", value: "token", expectedRevision: null })

    vi.stubEnv("VITEHUB_CONNECTIONS_KEY", keyA.toString("base64"))
    vi.stubEnv("VITEHUB_CONNECTIONS_KEYS", `${keyB.toString("hex")}, ${keyA.toString("base64")}`)
    useDatabase(db)
    const handler = createConnectionsHandler({ actor: () => "user:local", runtime: () => getConnectionsRuntime() })
    const output = { stderr: "", stdout: "" }
    const context = {
      env: {},
      stderr: { write: (chunk: string | Uint8Array) => (output.stderr += String(chunk)) },
      stdout: { write: (chunk: string | Uint8Array) => (output.stdout += String(chunk)) },
    }
    const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => handler.fetch(new Request(input, init))) as typeof globalThis.fetch
    expect(await runConnectionsCli("rotate-key", ["--url", "http://127.0.0.1:4741", "--json"], context, { fetch, openBrowser: false })).toBe(0)
    expect(output.stderr).toBe("")
    expect(JSON.parse(output.stdout)).toEqual({ rotated: 1, skipped: 0 })

    // The previous key is gone from the keyring and the token still reads.
    vi.stubEnv("VITEHUB_CONNECTIONS_KEY", "")
    vi.stubEnv("VITEHUB_CONNECTIONS_KEYS", keyB.toString("base64"))
    useDatabase(db)
    expect(await createDatabaseConnectionStore({ db, encryptionKeys: [keyB] }).secrets.read("connection/mail")).toEqual({ value: "token", revision: written.revision })
    expect(await getConnectionsRuntime().rotateKey()).toEqual({ rotated: 0, skipped: 1 })
  }
  finally {
    client.close()
  }
})

it("rejects a keyring entry that is not 32 bytes", async () => {
  vi.stubEnv("VITEHUB_CONNECTIONS_KEY", "")
  vi.stubEnv("VITEHUB_CONNECTIONS_KEYS", `${keyB.toString("base64")},short`)
  const client = createClient({ url: ":memory:" })
  try {
    useDatabase(drizzle({ client }))
    await expect(getConnectionsRuntime().rotateKey()).rejects.toMatchObject({ code: "CONNECTIONS_NOT_CONFIGURED" })
  }
  finally {
    client.close()
  }
})
