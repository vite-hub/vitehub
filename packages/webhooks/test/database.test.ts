import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { expect, it } from "vitest"

import { createDrizzleWebhookStore, webhooksTables } from "../src/database.ts"

it("distinguishes an existing delivery from an insertion even when the IDs match", async () => {
  const client = createClient({ url: ":memory:" })
  try {
    await client.executeMultiple(`${webhooksTables.join(";\n")};`)
    const store = createDrizzleWebhookStore(drizzle({ client }))
    const send = { id: "first", webhook: "members", key: "same", event: "test", body: "{}", dueAt: 0, now: 0 }
    const results = await Promise.all([store.recordOnce(send), store.recordOnce(send)])
    expect(results.map(row => row.created)).toEqual(expect.arrayContaining([true, false]))
    expect(results.map(row => row.id)).toEqual([send.id, send.id])
    await expect(store.recordOnce({ ...send, id: "second" })).resolves.toMatchObject({ id: send.id, created: false })
    await expect(store.recordOnce({ ...send, key: "different" })).rejects.toMatchObject({ code: "WEBHOOKS_STORE_FAILED" })
    await expect(store.recordOnce({ ...send, webhook: "other" })).rejects.toMatchObject({ code: "WEBHOOKS_STORE_FAILED" })
    expect(await store.list()).toHaveLength(1)
  }
  finally {
    client.close()
  }
})
