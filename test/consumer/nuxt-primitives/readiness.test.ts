import { expect, it, vi } from "vitest"

import { withNitroReadiness } from "./row.ts"

function unavailable() {
  return new Response(null, {
    status: 503,
    statusText: "Dev server is unavailable",
    headers: { refresh: "3" },
  })
}

it("retries an interrupted Nuxt dev read", async () => {
  const dispatch = vi.fn()
    .mockResolvedValueOnce(unavailable())
    .mockResolvedValueOnce(new Response("published"))
  const probe = withNitroReadiness("cloudflare-dev", dispatch)
  expect(await (await probe("/published")).text()).toBe("published")
  expect(dispatch).toHaveBeenCalledTimes(2)
})

it.each([400, 201])("returns the form's %i after a Nitro dev interruption", async (status) => {
  const dispatch = vi.fn()
    .mockResolvedValueOnce(unavailable())
    .mockResolvedValueOnce(new Response(null, { status }))
  const probe = withNitroReadiness("cloudflare-dev", dispatch, { replaySafe: true })
  const path = "/_vitehub/forms/primitive-contact"
  const init = {
    method: "POST",
    body: JSON.stringify({ email: "ada@example.com", message: "hello" }),
    headers: { "idempotency-key": crypto.randomUUID() },
  }
  expect((await probe(path, init)).status).toBe(status)
  expect(dispatch.mock.calls).toEqual([[path, init], [path, init]])
})

it("does not retry Nuxt writes, build probes, or application errors", async () => {
  const dispatch = vi.fn()
    .mockResolvedValueOnce(unavailable())
    .mockResolvedValueOnce(unavailable())
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
  expect((await withNitroReadiness("cloudflare-dev", dispatch)("/publish", { method: "POST" })).status).toBe(503)
  expect((await withNitroReadiness("cloudflare-build", dispatch, { replaySafe: true })("/publish", { method: "POST" })).status).toBe(503)
  expect((await withNitroReadiness("cloudflare-dev", dispatch, { replaySafe: true })("/application-error", { method: "POST" })).status).toBe(503)
  expect(dispatch).toHaveBeenCalledTimes(3)
})
