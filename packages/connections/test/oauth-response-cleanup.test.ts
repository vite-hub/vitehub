import { expect, it, vi } from "vitest"

import { createConnectionsRuntime } from "../src/runtime.ts"
import { ACCESS_TOKEN, connect, createTestRuntime, mailConnection } from "./helpers.ts"

it.each(["retry", "cancel-fails", "cancel-pending", "refresh-fails"] as const)("starts releasing the discarded OAuth response before refreshing (%s)", async (scenario) => {
  const test = createTestRuntime()
  await connect(test)
  const events: string[] = []
  const cancel = vi.fn(() => {
    events.push("cancel")
    if (scenario === "cancel-fails") throw new Error("Response cleanup failed")
    if (scenario === "cancel-pending") return new Promise<void>(() => {})
  })
  const unauthorized = new Response(new ReadableStream({ cancel }), { status: 401 })
  const runtime = createConnectionsRuntime({
    definitions: { mail: mailConnection() },
    fetch: async (input, init) => {
      if (new Headers(init?.headers).get("authorization") === `Bearer ${ACCESS_TOKEN}`) return unauthorized
      if (String(init?.body).includes("grant_type=refresh_token")) events.push("refresh")
      return await test.provider.fetch(input, init)
    },
    now: () => test.now.value,
    store: test.store,
  })
  test.provider.valid = new Set(["access-2"])
  test.provider.tokenResponses.push(scenario === "refresh-fails"
    ? { body: { error: "invalid_grant" }, status: 400 }
    : { body: { access_token: "access-2", expires_in: 3600 } })

  const result = runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })
  if (scenario === "refresh-fails") await expect(result).rejects.toMatchObject({ code: "CONNECTIONS_NEEDS_RECONNECT" })
  else await expect(result).resolves.toEqual({ labels: [{ id: "INBOX" }] })

  expect(events).toEqual(["cancel", "refresh"])
  expect(cancel).toHaveBeenCalledOnce()
  expect(unauthorized.bodyUsed).toBe(true)
})
