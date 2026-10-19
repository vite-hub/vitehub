import { afterEach, describe, expect, it, vi } from "vitest"

import { normalizeRetention, parseRetentionDuration, parseRetentionSize } from "../src/internal/retention-policy.ts"

import type { NormalizeRetentionOptions } from "../src/internal/retention-policy.ts"

const statfs = vi.hoisted(() => vi.fn<(path: string) => Promise<{ blocks: number, bsize: number }>>())
vi.mock("node:fs/promises", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs/promises")>(), statfs }))

const { retentionBudgetBytes } = await import("../src/internal/retention-volume.ts")

class RetentionTestError extends Error {}

const options = (input: Partial<NormalizeRetentionOptions> = {}): NormalizeRetentionOptions => ({
  label: "Test store",
  defaults: { maxAgeMs: 1_000, maxRecords: 10, maxSize: false },
  size: "any",
  error: message => new RetentionTestError(message),
  ...input,
})

const second = 1_000
const hour = 60 * 60 * second
const day = 24 * hour
const MiB = 1024 * 1024

afterEach(() => {
  statfs.mockReset()
})

describe("retention durations", () => {
  it.each([
    ["250ms", 250],
    ["45s", 45 * second],
    ["30m", 30 * 60 * second],
    ["12h", 12 * hour],
    ["1.5h", 1.5 * hour],
    ["14d", 14 * day],
    ["2w", 14 * day],
    [" 7d ", 7 * day],
  ])("parses %j", (value, expected) => {
    expect(parseRetentionDuration(value)).toBe(expected)
  })

  it.each(["", "14", "d", "0d", "-1d", "14 days", "14D", "1e3s", "0.0001ms", "1y"])("rejects %j", (value) => {
    expect(parseRetentionDuration(value)).toBeUndefined()
  })
})

describe("retention sizes", () => {
  it.each([
    ["10B", { bytes: 10 }],
    ["1kb", { bytes: 1024 }],
    ["1.5KB", { bytes: 1536 }],
    ["500MB", { bytes: 500 * MiB }],
    ["3 GB", { bytes: 3 * 1024 * MiB }],
    ["1TB", { bytes: 1024 ** 4 }],
    ["45%", { fraction: 0.45 }],
    ["100 %", { fraction: 1 }],
    ["0.5%", { fraction: 0.005 }],
  ])("parses %j", (value, expected) => {
    expect(parseRetentionSize(value)).toEqual(expected)
  })

  it.each(["", "MB", "0MB", "-1MB", "0.1B", "2PB", "1 G", "0%", "101%", "%", "45"])("rejects %j", (value) => {
    expect(parseRetentionSize(value)).toBeUndefined()
  })
})

describe("normalizeRetention", () => {
  it("uses the defaults for undefined input and undefined limits", () => {
    expect(normalizeRetention(undefined, options())).toEqual({ maxAgeMs: 1_000, maxRecords: 10, maxSize: false })
    expect(normalizeRetention({ maxAge: undefined }, options())).toEqual({ maxAgeMs: 1_000, maxRecords: 10, maxSize: false })
  })

  it("resolves units and disables limits with false", () => {
    expect(normalizeRetention({ maxAge: "14d", maxRecords: 5, maxSize: "30%" }, options())).toEqual({ maxAgeMs: 14 * day, maxRecords: 5, maxSize: { fraction: 0.3 } })
    expect(normalizeRetention({ maxAge: 60_000, maxSize: 4096 }, options())).toEqual({ maxAgeMs: 60_000, maxRecords: 10, maxSize: { bytes: 4096 } })
    expect(normalizeRetention({ maxAge: false, maxRecords: false, maxSize: false }, options({ defaults: { maxAgeMs: 1, maxRecords: 1, maxSize: { bytes: 1 } } })))
      .toEqual({ maxAgeMs: false, maxRecords: false, maxSize: false })
  })

  it.each([null, [], "14d", 14])("rejects %j as the policy", (input) => {
    expect(() => normalizeRetention(input, options())).toThrow(RetentionTestError)
    expect(() => normalizeRetention(input, options())).toThrow("Test store must be an object with maxAge, maxRecords, or maxSize.")
  })

  it("rejects unknown keys and points maxAgeMs to maxAge", () => {
    expect(() => normalizeRetention({ maxAgeMs: 1_000 }, options())).toThrow('Test store has an unknown key "maxAgeMs". Rename it to maxAge.')
    expect(() => normalizeRetention({ maxBytes: 1 }, options())).toThrow('Test store has an unknown key "maxBytes". Use maxAge, maxRecords, or maxSize.')
  })

  it.each([null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, "1000", "0d", true])("rejects maxAge %j", (maxAge) => {
    expect(() => normalizeRetention({ maxAge }, options())).toThrow("Test store maxAge must be a positive duration such as 14d, a number of milliseconds, or false.")
  })

  it.each([null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "10", true])("rejects maxRecords %j", (maxRecords) => {
    expect(() => normalizeRetention({ maxRecords }, options())).toThrow("Test store maxRecords must be a positive safe integer or false.")
  })

  it.each([null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "0%", "101%", "2PB", "lots", true])("rejects maxSize %j", (maxSize) => {
    expect(() => normalizeRetention({ maxSize }, options())).toThrow("Test store maxSize must be a positive size such as 500MB, a number of bytes, a percent such as 45%, or false.")
  })

  it("applies the size mode", () => {
    expect(() => normalizeRetention({ maxSize: "500MB" }, options({ size: "none" }))).toThrow("Test store stores do not support maxSize. Use maxRecords or maxAge.")
    expect(() => normalizeRetention({ maxSize: "45%" }, options({ size: "none" }))).toThrow("do not support maxSize")
    expect(normalizeRetention({ maxSize: false }, options({ size: "none" })).maxSize).toBe(false)
    expect(() => normalizeRetention({ maxSize: "45%" }, options({ size: "bytes" }))).toThrow("Test store maxSize does not support a percent. Use a size such as 500MB.")
    expect(normalizeRetention({ maxSize: "1GB" }, options({ size: "bytes" })).maxSize).toEqual({ bytes: 1024 * MiB })
  })
})

describe("retentionBudgetBytes", () => {
  it("returns bytes without reading the volume", async () => {
    await expect(retentionBudgetBytes({ bytes: 4096 }, "/data/bytes/journal.sqlite")).resolves.toBe(4096)
    expect(statfs).not.toHaveBeenCalled()
  })

  it("resolves a percent against the capacity of the volume and caches it for 10 minutes", async () => {
    statfs.mockResolvedValue({ blocks: 1_000, bsize: 4096 })
    const now = Date.now()
    await expect(retentionBudgetBytes({ fraction: 0.45 }, "/data/percent/journal.sqlite", now)).resolves.toBe(Math.floor(0.45 * 4_096_000))
    expect(statfs).toHaveBeenCalledWith("/data/percent")

    statfs.mockResolvedValue({ blocks: 2_000, bsize: 4096 })
    await expect(retentionBudgetBytes({ fraction: 0.5 }, "/data/percent/other.sqlite", now + 9 * 60 * 1000)).resolves.toBe(2_048_000)
    expect(statfs).toHaveBeenCalledTimes(1)
    await expect(retentionBudgetBytes({ fraction: 0.5 }, "/data/percent/journal.sqlite", now + 10 * 60 * 1000)).resolves.toBe(4_096_000)
    expect(statfs).toHaveBeenCalledTimes(2)
  })
})
