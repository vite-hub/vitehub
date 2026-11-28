import { expect, it, vi } from "vitest"

import { access } from "./access.ts"
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

it("retries the rejected form submission when the Nitro worker restarts", async () => {
  const mode = "cloudflare-dev"
  const origin = "http://127.0.0.1:3000"
  const dispatch = vi.fn()
    .mockResolvedValueOnce({ url: origin })
    .mockResolvedValueOnce(unavailable())
    .mockResolvedValueOnce(new Response("Enter a valid email.", { status: 400 }))
    .mockResolvedValueOnce(Response.json({ id: "submission" }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ data: { email: "ada@example.com", message: `message from ${mode}` }, form: "primitive-contact", status: "open" }))
  const forms = access.find(row => row.id === "forms")!
  await forms.probe({ appDir: "", fetch: dispatch, mode, origin, target: "cloudflare" })
  expect(dispatch).toHaveBeenCalledTimes(5)
  expect(dispatch.mock.calls[1]).toEqual(dispatch.mock.calls[2])
})
