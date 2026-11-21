import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { expect, it, vi } from "vitest"

import { createDrizzleWebhookStore, webhooksTables } from "../src/database.ts"
import { defineWebhook } from "../src/index.ts"
import { deliverWebhookWake, installWebhooks } from "../src/runtime.ts"

it("reschedules an early recovery wake until the interrupted claim expires", async () => {
  const client = createClient({ url: ":memory:" })
  await client.executeMultiple(`${webhooksTables.join(";\n")};`)
  const store = createDrizzleWebhookStore(drizzle({ client }))
  const wake = vi.fn().mockResolvedValue([undefined, undefined])
  const request = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
  vi.stubGlobal("fetch", request)
  vi.stubEnv("WEBHOOK_RECOVERY_URL", "https://example.com/webhook")
  vi.stubEnv("WEBHOOK_RECOVERY_SECRET", "recovery-secret")
  installWebhooks({
    webhooks: { recovery: defineWebhook({ url: "WEBHOOK_RECOVERY_URL", secret: "WEBHOOK_RECOVERY_SECRET" }) },
    store,
    wake,
  })
  const now = Date.now()
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 1_000)
  try {
    const recorded = await store.record({
      id: "whd_recovery", webhook: "recovery", key: null, event: "recovery", body: JSON.stringify({ recovered: true }), dueAt: now, now,
    })
    await store.claim(recorded.id, recorded.revision, now, now - 70_000)
    await deliverWebhookWake(recorded)
    expect(wake).toHaveBeenCalledExactlyOnceWith(
      { id: recorded.id, revision: recorded.revision }, { delay: "70s" },
    )
    expect(await store.get(recorded.id)).toMatchObject({ state: "sending", attempts: 1 })
    expect(request).not.toHaveBeenCalled()
    // A failed replacement wake must leave the original Queue job eligible for retry.
    wake.mockResolvedValueOnce([new Error("queue unavailable"), undefined])
    await expect(deliverWebhookWake(recorded)).rejects.toMatchObject({ code: "WEBHOOKS_WAKE_FAILED" })
    clock.mockReturnValue(now + 71_000)
    await deliverWebhookWake(recorded)
    expect(await store.get(recorded.id)).toMatchObject({ state: "sent", attempts: 2 })
    expect(request).toHaveBeenCalledOnce()
  }
  finally {
    clock.mockRestore()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    client.close()
  }
})
