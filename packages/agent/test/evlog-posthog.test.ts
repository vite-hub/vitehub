import { afterEach, expect, it, vi } from "vitest"
import { posthogAgentExporter } from "../src/evlog/posthog.ts"

afterEach(() => vi.unstubAllGlobals())

it("requires an acknowledgement and preserves retry identities", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response("offline", { status: 503 })).mockResolvedValueOnce(Response.json({ status: "Ok" }))
  vi.stubGlobal("fetch", fetch)
  const exporter = posthogAgentExporter({ apiKey: "secret", service: "test" })
  const uuid = crypto.randomUUID()
  await exporter.capture("papercut_reported", { message: "Example" }, { uuid, timestamp: new Date("2026-09-05T00:00:00Z") })
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fetch.mock.calls[0]![1].body).toBe(fetch.mock.calls[1]![1].body)
  expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).batch[0]).toMatchObject({ uuid, timestamp: "2026-09-05T00:00:00.000Z" })
  await exporter.flush()
})

it("infers the distinct ID from event metadata and accepts an explicit override", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ status: "Ok" }))
  vi.stubGlobal("fetch", fetch)
  await posthogAgentExporter({ apiKey: "secret" }).capture("summary", { service: "inferred-service" })
  await posthogAgentExporter({ apiKey: "secret", service: "override" }).capture("summary", { service: "ignored" })
  const batches = fetch.mock.calls.map(call => JSON.parse(String(call[1]?.body)).batch[0])
  expect(batches.map(batch => batch.distinct_id)).toEqual(["inferred-service", "override"])
})

it.each([200, 401])("rejects HTTP %s without an acknowledgement and hides response content", async (status) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ detail: "secret", status: "wrong" }, { status }))
  vi.stubGlobal("fetch", fetch)
  const exporter = posthogAgentExporter({ apiKey: "secret", service: "test" })
  await expect(exporter.capture("report", {})).rejects.toThrow("did not acknowledge")
  expect(fetch).toHaveBeenCalledOnce()
  await exporter.flush()
})

it("uses PostHog's exception parser with acknowledged delivery", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ status: "Ok" }))
  vi.stubGlobal("fetch", fetch)
  const exporter = posthogAgentExporter({ apiKey: "secret", service: "test" })
  await exporter.exception(new Error("safe diagnostic"), { run_id: "run" })
  const batch = JSON.parse(String(fetch.mock.calls[0]![1]?.body)).batch[0]
  expect(batch.event).toBe("$exception")
  expect(batch.properties.$exception_list).toHaveLength(1)
  expect(batch.properties.run_id).toBe("run")
  await exporter.flush()
})

it("rejects exception delivery without an acknowledgement", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("offline", { status: 503 }))
  vi.stubGlobal("fetch", fetch)
  const exporter = posthogAgentExporter({ apiKey: "secret", service: "test" })
  await expect(exporter.exception(new Error("safe diagnostic"), { run_id: "run" })).rejects.toThrow("did not acknowledge")
  expect(fetch).toHaveBeenCalledTimes(3)
  await exporter.flush()
})
