import { describe, expect, it } from "vitest"

import { defineAgent, runAgent } from "../src/index.ts"
import { labeller } from "../src/presets/labeller.ts"

const message = {
  attachments: [],
  body: "Your invoice is ready",
  cc: [],
  date: "2026-10-10T18:55:00.000Z",
  from: "billing@example.test",
  headers: { "list-id": "billing.example.test" },
  id: "m1",
  labelIds: ["INBOX"],
  snippet: "Your invoice is ready",
  subject: "Invoice 42",
  threadId: "t1",
  to: ["me@example.test"],
}

function configured(options: Record<string, unknown> = {}) {
  return defineAgent({ preset: "labeller", presets: { labeller }, options: {
    labels: { Receipts: { description: "Purchases" }, Work: { description: "Work" } },
    ...options,
  } })
}

describe("labeller preset", () => {
  it("uses the first matching rule before Jev", async () => {
    const agent = configured({ rules: {
      receipts: { subject: "invoice", label: "Receipts", archive: true },
      work: { from: "example.test", label: "Work" },
    } })
    const intercept = agent.intercept as unknown as (context: { context: { get: (key: string) => unknown } }) => unknown
    expect(await intercept({ context: { get: () => message } })).toEqual({ label: "Receipts", rule: "receipts" })
  })

  it("rejects unsafe configuration and keeps destructive defaults off", async () => {
    expect(configured().options.dryRun).toBe(true)
    expect(configured().options.minConfidence).toBe(0.6)
    expect(configured().options.trashEnabled).toBe(false)
    const attempt = (options: Record<string, unknown>) => Promise.resolve().then(() => runAgent(configured(options), { runtime: "unknown", memo: () => undefined, waitUntil: () => {} } as never, { prompt: "test" }))
    await expect(attempt({ labels: { none: {} } })).rejects.toThrow(/reserved or invalid/)
    await expect(attempt({ labels: { Work: {} }, rules: { bad: { label: "Missing" } } })).rejects.toThrow(/undeclared label/)
    await expect(attempt({ labels: { Work: {} }, rules: { bad: { subject: "" } } })).rejects.toThrow(/non-empty strings/)
    await expect(attempt({ labels: { Work: {} }, rules: { bad: { archive: true } } })).rejects.toThrow(/must declare a label/)
  })

  it("accepts trash policy declarations while keeping the gate explicit", () => {
    const agent = configured({ rules: { cleanup: { subject: "invoice", label: "Receipts", trash: true } } })
    expect(agent.options.trashEnabled).toBe(false)
    const enabled = configured({ trashEnabled: true, dryRun: false, rules: { cleanup: { subject: "invoice", label: "Receipts", trash: true } } })
    expect(enabled.options.trashEnabled).toBe(true)
    expect(enabled.options.dryRun).toBe(false)
  })

  it("only writes for allowlisted labels with finite confidence", async () => {
    const calls: string[] = []
    const message = {
      channel: "gmail",
      label: async (name: string) => { calls.push(`label:${name}`) },
      archive: async () => { calls.push("archive") },
      markRead: async () => { calls.push("read") },
      star: async () => { calls.push("star") },
      trash: async () => { calls.push("trash") },
    }
    const agent = configured({ actions: { Work: { archive: true, trash: true } }, trashEnabled: false })
    const finish = agent.hooks?.["agent:finish"] as unknown as (event: { message: unknown, result: unknown }) => Promise<void>
    for (const confidence of [undefined, Number.NaN, Infinity, -0.1, 1.1, "0.9"]) {
      await finish({ message, result: { label: { choice: "Work", confidence, probabilities: { Work: 0.99 } } } })
    }
    await finish({ message, result: { label: { choice: "Unknown", confidence: 1, probabilities: { Unknown: 1 } } } })
    await finish({ message, result: { label: { choice: "Work", confidence: 0.8, probabilities: { Work: 0.9 } } } })
    expect(calls).toEqual(["label:Work", "archive"])
  })

  it("gates Jev writes on answer confidence instead of label probability", async () => {
    const calls: string[] = []
    const message = {
      channel: "gmail",
      label: async (name: string) => { calls.push(`label:${name}`) },
      archive: async () => { calls.push("archive") },
    }
    const agent = configured({ actions: { Work: { archive: true } } })
    const finish = agent.hooks?.["agent:finish"] as unknown as (event: { message: unknown, result: unknown }) => Promise<void>
    await finish({ message, result: { label: { choice: "Work", confidence: 0.4, probabilities: { Work: 0.99 } } } })
    expect(calls).toEqual([])
    await finish({ message, result: { label: { choice: "Work", confidence: 0.6, probabilities: { Work: 0.5 } } } })
    expect(calls).toEqual(["label:Work", "archive"])
  })

  it("applies label actions to rule-selected labels", async () => {
    const calls: string[] = []
    const message = {
      channel: "gmail",
      label: async (name: string) => { calls.push(`label:${name}`) },
      archive: async () => { calls.push("archive") },
      markRead: async () => { calls.push("read") },
      star: async () => { calls.push("star") },
      trash: async () => { calls.push("trash") },
    }
    const agent = configured({
      actions: { Receipts: { archive: true, star: true } },
      rules: { receipts: { subject: "invoice", label: "Receipts" } },
    })
    const finish = agent.hooks?.["agent:finish"] as unknown as (event: { message: unknown, result: unknown }) => Promise<void>
    await finish({ message, result: { label: "Receipts", rule: "receipts" } })
    expect(calls).toEqual(["label:Receipts", "archive", "star"])
  })
})
