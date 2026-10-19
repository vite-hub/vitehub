import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"
import resend from "../src/drivers/resend.ts"
import type { EmailMessage } from "../src/types.ts"

const message: EmailMessage = { from: "a@example.com", to: "b@example.com", subject: "s", text: "t" }

describe("cross realm date repro", () => {
  it("accepts a Date from another realm", async () => {
    const date = runInNewContext("new Date('2026-08-26T12:00:00.000Z')") as Date
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ id: "id" }), { status: 200 }))
    const driver = resend({ apiKey: "re_secret", fetch })
    const result = await driver.send({ ...message, scheduledAt: date }, { attempt: 1, driver: "resend", meta: {} })
    expect(result).toMatchObject({ data: { id: "id" }, error: null })
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ scheduled_at: "2026-08-26T12:00:00.000Z" })
  })
})
