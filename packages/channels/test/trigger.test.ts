import { afterEach, describe, expect, it, vi } from "vitest"

import { sendChannelTrigger } from "../src/index.ts"

const key = Symbol.for("vitehub.channels.triggerDispatcher")
type Holder = typeof globalThis & { [key]?: unknown }

afterEach(() => {
  delete (globalThis as Holder)[key]
})

describe("sendChannelTrigger()", () => {
  it("returns an error when no Agent webhook queue runs", async () => {
    const [error, receipt] = await sendChannelTrigger("airtable", "webhook", {})
    expect(error).toMatchObject({ code: "CHANNEL_TRIGGER_FAILED", why: 'The trigger "webhook" of Channel "airtable" could not start.' })
    expect(receipt).toBeUndefined()
  })

  it("passes the trigger to the Agent delivery core and returns its receipt or error", async () => {
    const dispatch = vi.fn()
      .mockResolvedValueOnce({ deliveryId: "d-1", queued: true })
      .mockRejectedValueOnce(new Error("State cannot queue"))
    ;(globalThis as Holder)[key] = dispatch

    await expect(sendChannelTrigger("airtable", "webhook", { id: 1 })).resolves.toEqual([undefined, { deliveryId: "d-1", queued: true }])
    expect(dispatch).toHaveBeenCalledWith("airtable", "webhook", { id: 1 })
    const [error] = await sendChannelTrigger("airtable", "webhook", { id: 2 })
    expect(error?.cause).toHaveProperty("message", "State cannot queue")
  })
})
