import { describe, expect, it, vi } from "vitest"

import { createTraceEventLog } from "../src/index.ts"
import { traceEventsToOpenTelemetryLogRecords, traceEventsToOpenTelemetrySpans } from "../src/internal/trace.ts"

describe("trace attribute projection", () => {
  it.each(["metadata", "content"] as const)("does not execute nested accessors when exporting a %s log as metadata", async (content) => {
    const getter = vi.fn(() => { throw new Error("must not be read") })
    const details = Object.defineProperties({ safe: true }, {
      prompt: { enumerable: true, get: getter },
      unsafe: { enumerable: true, get: getter },
    })
    const list = [details, "replaced by accessor"]
    Object.defineProperty(list, 1, { enumerable: true, get: getter })
    const log = createTraceEventLog({ content })
    await log.append({ attributes: { details, list }, name: "agent.invocation", type: "run" })

    const expectedDetails = { safe: true, "content.omitted": ["prompt"] }
    const expectedList = [expectedDetails]
    expectedList.length = 2
    const expected = { details: expectedDetails, list: expectedList }
    const entries = log.entries()
    if (content === "metadata") expect(entries[0]?.attributes).toEqual(expected)
    else {
      expect(entries[0]?.attributes?.details).toBe(details)
      expect(traceEventsToOpenTelemetryLogRecords(entries, { content })[0]?.attributes?.details).toBe(details)
      expect(traceEventsToOpenTelemetrySpans(entries, { content })[0]?.attributes?.list).toBe(list)
    }
    expect(traceEventsToOpenTelemetryLogRecords(entries, { content: "metadata" })[0]?.attributes).toMatchObject(expected)
    expect(traceEventsToOpenTelemetrySpans(entries, { content: "metadata" })[0]?.attributes).toEqual({ ...expected, "vitehub.run.id": "default", "vitehub.trace.id": "default" })
    expect(getter).not.toHaveBeenCalled()
  })

  it("preserves sparse arrays, circular markers, and unsupported values in metadata", async () => {
    const callback = () => "ok"
    const shared = { callback, prompt: "private", safe: true }
    const cycle: Record<string, unknown> = { shared }
    cycle.self = cycle
    const list = [shared]
    list.length = 3
    list[2] = shared
    const log = createTraceEventLog()
    await log.append({ attributes: { cycle, list }, name: "custom.event", type: "lifecycle" })

    const safe = { callback, safe: true, "content.omitted": ["prompt"] }
    const expectedList = [safe]
    expectedList.length = 3
    expectedList[2] = safe
    expect(log.entries()[0]?.attributes).toEqual({ cycle: { shared: safe, self: "[Circular]" }, list: expectedList })
  })

  it("inspects omission markers without invoking their accessors", async () => {
    const getter = vi.fn(() => "private")
    const omitted = ["request", "replaced by accessor", "vitehub.payload.value"]
    Object.defineProperty(omitted, 1, { enumerable: true, get: getter })
    const log = createTraceEventLog({ content: "content" })
    await log.append({ attributes: { "content.omitted": omitted }, name: "custom.event", type: "lifecycle" })

    expect(log.entries()[0]?.attributes).toEqual({ "content.omitted": ["request"] })
    expect(getter).not.toHaveBeenCalled()
  })
})
