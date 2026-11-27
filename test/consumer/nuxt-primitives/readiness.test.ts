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

it("does not retry Nuxt writes, build probes, or application errors", async () => {
  const dispatch = vi.fn()
    .mockResolvedValueOnce(unavailable())
    .mockResolvedValueOnce(unavailable())
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
  expect((await withNitroReadiness("cloudflare-dev", dispatch)("/publish", { method: "POST" })).status).toBe(503)
  expect((await withNitroReadiness("cloudflare-build", dispatch)("/published")).status).toBe(503)
  expect((await withNitroReadiness("cloudflare-dev", dispatch)("/application-error")).status).toBe(503)
  expect(dispatch).toHaveBeenCalledTimes(3)
})
