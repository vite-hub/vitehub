import { describe, expect, it, vi } from "vitest"
import { createWebhookRedelivery } from "../src/babysitter/webhook-redelivery.ts"

const delivery = (id: number, guid = `g${id}`) => ({ id: String(id), guid, event: "check_suite", action: "completed", deliveredAt: id, statusCode: 500, attempts: 1 })

function setup(failed: () => ReturnType<typeof delivery>[]) {
  let now = 10 * 3_600_000
  const source = { failedDeliveries: vi.fn(async (_since: number) => failed()), redeliver: vi.fn(async (_id: string) => {}) }
  const event = vi.fn()
  const redelivery = createWebhookRedelivery({ source, event, error: vi.fn(), pauseMs: 0, now: () => now })
  return { source, event, redelivery, advance: (ms: number) => { now += ms }, now: () => now }
}

describe("Babysitter webhook redelivery", () => {
  it("sends failed deliveries again and reports them", async () => {
    const f = setup(() => [delivery(1), delivery(2)])
    expect(await f.redelivery.sweep()).toBe(2)
    expect(f.source.redeliver.mock.calls.map(([id]) => id)).toEqual(["1", "2"])
    expect(f.event).toHaveBeenCalledWith("babysitter.webhook.redelivered", expect.objectContaining({ failed: 2, redelivered: 2, events: { "check_suite.completed": 2 } }))
  })

  it("looks back two hours first, then to the previous complete sweep with an overlap", async () => {
    const f = setup(() => [])
    const first = f.now()
    await f.redelivery.sweep()
    expect(f.source.failedDeliveries.mock.calls[0]![0]).toBe(first - 2 * 3_600_000)
    f.advance(5 * 60_000)
    await f.redelivery.sweep()
    expect(f.source.failedDeliveries.mock.calls[1]![0]).toBe(first - 20 * 60_000)
  })

  it("keeps deliveries past the limit or after a failed request for the next sweep", async () => {
    let now = 10 * 3_600_000
    const pending = new Map(Array.from({ length: 411 }, (_, index) => [String(index + 1), { ...delivery(index + 1), deliveredAt: now - 3_600_000 + index }]))
    const source = {
      failedDeliveries: vi.fn(async (since: number) => [...pending.values()].filter(item => item.deliveredAt >= since)),
      redeliver: vi.fn(async (id: string) => {
        if (id === "5" && source.redeliver.mock.calls.filter(([call]) => call === "5").length === 1) throw new Error("GitHub 502")
        pending.delete(id)
      }),
    }
    const redelivery = createWebhookRedelivery({ source, event: vi.fn(), error: vi.fn(), pauseMs: 0, now: () => now })
    const sent: number[] = []
    for (let sweep = 0; sweep < 4; sweep++) {
      sent.push(await redelivery.sweep())
      now += 5 * 60_000
    }
    expect(sent.reduce((sum, count) => sum + count, 0)).toBe(411)
    expect(pending.size).toBe(0)
  })

  it("gives up on an event after three redeliveries", async () => {
    const f = setup(() => [delivery(1)])
    for (let sweep = 0; sweep < 5; sweep++) await f.redelivery.sweep()
    expect(f.source.redeliver).toHaveBeenCalledTimes(3)
  })

  it("keeps going when one redelivery fails", async () => {
    const f = setup(() => [delivery(1), delivery(2)])
    f.source.redeliver.mockRejectedValueOnce(new Error("404"))
    expect(await f.redelivery.sweep()).toBe(1)
  })
})
