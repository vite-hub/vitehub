import { describe, expect, it } from "vitest"

import { createPapercutIndex, createPapercutReporter } from "../src/capabilities.ts"
import type { Papercut } from "../src/capabilities.ts"

function papercut(id: string, message: string, agent = "support"): Papercut {
  return { agent: { name: agent }, createdAt: new Date(0).toISOString(), id, message, source: "tool" }
}

describe("createPapercutIndex", () => {
  it("lists known papercuts with counts for a digest", async () => {
    let now = Date.parse("2026-11-05T00:00:00Z")
    const index = createPapercutIndex({ now: () => now })
    index.record(papercut("a", "Productlane threads_get exposes an empty input schema but requires an id."))
    now += 60_000
    index.record(papercut("b", "Productlane threads_get is exposed with no input fields and fails with a missing id."))
    index.record(papercut("c", "Git commit failed because the checkout has no author identity."))

    expect(await index.list()).toMatchObject([
      { id: "a", count: 2, agent: "support", firstReportedAt: "2026-11-05T00:00:00.000Z", lastReportedAt: "2026-11-05T00:01:00.000Z" },
      { id: "c", count: 1 },
    ])
  })

  it("keeps Agents apart and forgets papercuts after the window", () => {
    let now = 0
    const index = createPapercutIndex({ now: () => now, windowMs: 1_000 })
    index.record(papercut("a", "The apply_patch tool is missing."))
    expect(index.record(papercut("b", "The apply_patch tool is missing.", "triage")).count).toBe(1)
    now = 2_000
    expect(index.record(papercut("c", "The apply_patch tool is missing.")).count).toBe(1)
  })

  it("strips IDs, hashes, numbers, and directory prefixes before comparing", () => {
    const index = createPapercutIndex()
    index.record(papercut("a", "GitHub returned HTTP 401 for PR #1419 at commit 6ae9f07 in /tmp/run-1/checkout."))
    expect(index.record(papercut("b", "GitHub returned HTTP 403 for PR #1473 at commit 0b1c2d3e in /work/run-9/checkout.")).count).toBe(2)
  })

  it("adds known and repeated counts to the durable reporter status", async () => {
    const reporter = createPapercutReporter({ invocations: () => { throw new Error("unused") }, send: async () => {} })
    reporter.index.record(papercut("a", "The apply_patch tool is missing."))
    reporter.index.record(papercut("b", "The apply_patch tool is missing again."))
    expect(reporter.status()).toMatchObject({ known: 1, repeats: 1 })
    await reporter.stop()
  })
})
