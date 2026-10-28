import { createLogger, initLogger } from "evlog"
import { Diagnostic } from "nostics"
import { describe, expect, it } from "vitest"
import { createLogBuffer } from "../src/logs/memory.ts"
import { LogCursorExpiredError } from "../src/logs/source.ts"

const entry = (id: string) => ({ id, timestamp: "2026-10-28T12:00:00.000Z", level: "info" as const, service: "app", message: "Request completed", data: { request: id } })

describe("Logs source", () => {
  it("reuses Evlog emission and redaction while retaining Nostics guidance", async () => {
    const buffer = createLogBuffer()
    initLogger({ silent: true, redact: { paths: ["password"] }, drain: buffer.drain, env: { service: "logs-test" } })
    const logger = createLogger()
    const diagnostic = new Diagnostic({ code: "TEST_FAILED", why: "Provider unavailable", fix: "Retry", docs: "https://example.com/help", sources: ["server/api.ts:1:1"], data: { attempt: 1 } })
    logger.set({ password: "private-value", diagnostic: diagnostic.toJSON() })
    logger.emit()
    const page = await buffer.source.query({})
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]?.data.password).not.toBe("private-value")
    expect(page.entries[0]?.data.diagnostic).toMatchObject({ name: "TEST_FAILED", why: "Provider unavailable", fix: "Retry", data: { attempt: 1 }, sources: ["server/api.ts:1:1"] })
  })
  it("reads newest first with stable pagination while new events arrive", async () => {
    const buffer = createLogBuffer()
    for (const id of ["a", "b", "c"]) buffer.append(entry(id))
    const first = await buffer.source.query({ limit: 2 })
    expect(first.entries.map(event => event.id)).toEqual(["c", "b"])
    buffer.append(entry("d"))
    expect((await buffer.source.query({ cursor: first.cursor })).entries.map(event => event.id)).toEqual(["a"])
  })
  it("bounds retention, rejects expired cursors and deduplicates replay", async () => {
    const buffer = createLogBuffer({ maxEntries: 2 })
    buffer.append(entry("a")); buffer.append(entry("a")); buffer.append(entry("b"))
    expect((await buffer.source.query({})).entries).toHaveLength(2)
    buffer.append(entry("c"))
    expect((await buffer.source.query({})).dropped).toBe(1)
    await expect(buffer.source.query({ cursor: "a" })).rejects.toBeInstanceOf(LogCursorExpiredError)
  })
  it("snapshots structured fields and keeps query callers from mutating stored events", async () => {
    const buffer = createLogBuffer()
    const event = entry("a")
    buffer.append(event); event.data.request = "changed"
    const page = await buffer.source.query({})
    page.entries[0]!.data.request = "also changed"
    expect((await buffer.source.query({})).entries[0]?.data.request).toBe("a")
  })
  it("filters structured diagnostic fields, severity and service", async () => {
    const buffer = createLogBuffer()
    buffer.append({ ...entry("a"), level: "error", data: { diagnostic: { code: "DEMO_R001", why: "Denied", fix: "Grant access", data: { source: "notes" } } } })
    buffer.append(entry("b"))
    expect((await buffer.source.query({ text: "DEMO_R001", level: "error", service: "app" })).entries).toHaveLength(1)
    expect((await buffer.source.query({ service: "another" })).entries).toEqual([])
  })
  it("drops oversized entries without disrupting the producer and supports abort", async () => {
    const buffer = createLogBuffer({ maxEntryBytes: 256 })
    expect(() => buffer.append({ ...entry("a"), message: "x".repeat(500) })).not.toThrow()
    expect(await buffer.source.query({})).toMatchObject({ entries: [], dropped: 1 })
    await expect(buffer.source.query({}, { signal: AbortSignal.abort() })).rejects.toBeDefined()
    await expect(buffer.source.query({ limit: 501 })).rejects.toBeDefined()
  })
})
