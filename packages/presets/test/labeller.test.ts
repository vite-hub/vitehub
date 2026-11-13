import { describe, expect, it } from "vitest"

import { defineAgent } from "@vite-hub/agent"
import { runAgentWithContext } from "@vite-hub/agent/server/internal"
import { cleanupLabeller, labeller } from "../src/labeller.ts"

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
  return defineAgent({ extends: labeller, options: {
    labels: { Receipts: { description: "Purchases" }, Work: { description: "Work" } },
    ...options,
  } })
}

describe("labeller preset", () => {
  it("imports the template and validates consumer label counts", () => {
    expect(labeller).toBeDefined()
    expect(() => configured({ labels: {} })).toThrow(/between 1 and 254 labels/)
    const labels = Object.fromEntries(Array.from({ length: 254 }, (_, index) => [`Label${index}`, {}]))
    expect(() => configured({ labels })).not.toThrow()
    expect(() => configured({ labels: { ...labels, Extra: {} } })).toThrow(/between 1 and 254 labels/)
  })

  it("matches documented escaped literals without treating them as wildcards", async () => {
    const agent = configured({ rules: { receipts: { from: ["/billing\\./i"], label: "Receipts" } } })
    const intercept = (agent as unknown as { intercept: (context: { context: { get: (key: string) => unknown } }) => unknown }).intercept
    expect(await intercept({ context: { get: () => ({ ...message, from: "BILLING.example.test" }) } })).toEqual({ label: "Receipts", rule: "receipts" })
    expect(await intercept({ context: { get: () => message } })).toBeUndefined()
  })

  it("configures the documented extends form", async () => {
    const agent = defineAgent({ extends: labeller, options: {
      labels: { Receipts: {} },
      rules: { receipt: { subject: "invoice", label: "Receipts" } },
    } })
    const intercept = (agent as unknown as { intercept: (context: { context: { get: (key: string) => unknown } }) => unknown }).intercept
    expect(await intercept({ context: { get: () => message } })).toEqual({ label: "Receipts", rule: "receipt" })
  })

  it.each(["/^(a+)+$/", "/a*/", "/a{2}/", "/[a-z]/", "/\\1/", "/\\d/", "/a/ii"])("rejects unsafe or invalid regex pattern %s", (pattern) => {
    expect(() => configured({ rules: { bad: { body: pattern, label: "Receipts" } } })).toThrow(/regex patterns|regex pattern/)
  })

  it.each(["/invoice\\+/", "/invoice\\(/", "/invoice\\\\/"])("accepts escaped regex punctuation %s", (pattern) => {
    expect(() => configured({ rules: { receipt: { subject: pattern, label: "Receipts" } } })).not.toThrow()
  })

  it("uses the first matching rule before Jev", async () => {
    const agent = configured({ rules: {
      receipts: { subject: "invoice", label: "Receipts", archive: true },
      work: { from: "example.test", label: "Work" },
    } })
    const intercept = (agent as unknown as { intercept: (context: { context: { get: (key: string) => unknown } }) => unknown }).intercept
    expect(await intercept({ context: { get: () => message } })).toEqual({ label: "Receipts", rule: "receipts" })
  })

  it("rejects unsafe configuration and keeps destructive defaults off", async () => {
    expect(configured().options.dryRun).toBe(true)
    expect(configured().options.minConfidence).toBe(0.6)
    expect(configured().options.trashEnabled).toBe(false)
    const attempt = (options: Record<string, unknown>) => Promise.resolve().then(() => runAgentWithContext(configured(options), { runtime: "unknown", memo: () => undefined, waitUntil: () => {} } as never, { prompt: "test" }))
    await expect(attempt({ labels: { none: {} } })).rejects.toThrow(/reserved or invalid/)
    await expect(attempt({ labels: { Work: {} }, rules: { bad: { label: "Missing" } } })).rejects.toThrow(/undeclared label/)
    await expect(attempt({ labels: { Work: {} }, rules: { bad: { subject: "" } } })).rejects.toThrow(/non-empty strings/)
    await expect(attempt({ labels: { Work: {} }, rules: { bad: { archive: true } } })).rejects.toThrow(/must declare a label/)
  })

  it.each(["archive", "read", "star", "trash"])("rejects non-boolean %s flags from untyped options", (flag) => {
    for (const value of ["false", "true", 0, 1, null, {}, []]) {
      expect(() => configured({ actions: { Receipts: { [flag]: value } } })).toThrow(/must be a boolean/)
      expect(() => configured({ rules: { receipt: { label: "Receipts", [flag]: value } } })).toThrow(/must be a boolean/)
      expect(() => configured({ rules: { receipt: { not: { label: "Receipts", [flag]: value } } } })).toThrow(/must be a boolean/)
    }
  })

  it.each(["dryRun", "hideUnmanagedLabels", "trashEnabled"])("rejects non-boolean %s policy options", (policy) => {
    for (const value of ["false", "true", 0, 1, null, {}, []]) {
      expect(() => configured({ [policy]: value })).toThrow(/must be a boolean/)
    }
  })

  it("keeps explicit false action flags disabled for matching rules", async () => {
    const calls: string[] = []
    const message = {
      channel: "gmail",
      label: async (name: string) => { calls.push(`label:${name}`) },
      archive: async () => { calls.push("archive") },
      markRead: async () => { calls.push("read") },
      star: async () => { calls.push("star") },
      trash: async () => { calls.push("trash") },
    }
    const flags = { archive: false, read: false, star: false, trash: false }
    const agent = configured({
      actions: { Receipts: { archive: true, read: true, star: true, trash: true } },
      rules: { receipt: { label: "Receipts", ...flags } },
      trashEnabled: true,
    })
    const finish = agent.hooks?.["agent:finish"] as unknown as (event: { message: unknown, result: unknown }) => Promise<void>
    await finish({ message, result: { label: "Receipts", rule: "receipt" } })
    expect(calls).toEqual(["label:Receipts"])
  })

  it("still labels when an extension adds its own finish hook", async () => {
    const calls: string[] = []
    const message = { channel: "gmail", label: async (name: string) => { calls.push(`label:${name}`) } }
    const extension = defineAgent({
      extends: configured({ rules: { receipt: { subject: "invoice", label: "Receipts" } } }),
      hooks: { "agent:finish": () => { calls.push("extension") } },
    })
    const finish = extension.hooks?.["agent:finish"] as unknown as (event: { message: unknown, result: unknown }) => Promise<void>
    await finish({ message, result: { label: "Receipts", rule: "receipt" } })
    expect(calls).toEqual(["label:Receipts", "extension"])
  })

  it("rejects label colors outside Gmail's palette when the Agent is defined", () => {
    expect(configured().options.hideUnmanagedLabels).toBe(false)
    expect(() => configured({ labels: { Work: { color: { textColor: "#FFFFFF", backgroundColor: "#4A86E8" } } } })).not.toThrow()
    expect(() => configured({ labels: { Work: { color: { textColor: "#ffffff", backgroundColor: "#123456" } } } }))
      .toThrow(/label "Work" color backgroundColor "#123456" is not in Gmail's label palette/)
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

  it("keeps cleanup off until rules, apply, live mode, and trashEnabled are all set", async () => {
    const requests: string[] = []
    const client = async (request: { method: string, path: string }) => {
      requests.push(`${request.method} ${request.path}`)
      return request.path === "messages" ? { messages: [{ id: "m1" }] } : {}
    }
    expect(configured().options.cleanup).toEqual({})
    await expect(cleanupLabeller(configured({ client }), { apply: true })).resolves.toEqual({ applied: false, rules: [] })
    expect(requests).toEqual([])

    const cleanup = { receipts: { label: "Receipts", olderThan: 30 } }
    const preview = await cleanupLabeller(configured({ cleanup, client, dryRun: true }), { apply: true })
    expect(preview).toEqual({ applied: false, rules: [{ messageIds: ["m1"], query: 'label:"Receipts" older_than:30d -is:starred -in:trash', rule: "receipts" }] })
    await cleanupLabeller(configured({ cleanup, client, dryRun: false }))
    expect(requests).toEqual(["GET messages", "GET messages"])

    const trashOff = defineAgent({ extends: labeller, options: { labels: { Receipts: {} }, cleanup, client, dryRun: false } })
    await expect(cleanupLabeller(trashOff, { apply: true })).resolves.toMatchObject({ applied: false })
    expect(requests.slice(2)).toEqual(["GET messages"])

    const live = defineAgent({ extends: labeller, options: { labels: { Receipts: {} }, cleanup, client, dryRun: false, trashEnabled: true } })
    await expect(cleanupLabeller(live, { apply: true })).resolves.toMatchObject({ applied: true })
    expect(requests.slice(3)).toEqual(["GET messages", "POST messages/m1/trash"])
  })

  it("searches Spam too and skips messages that are gone before trash", async () => {
    const requests: string[] = []
    const queries: unknown[] = []
    const client = async (request: { method: string, path: string, query?: Record<string, unknown> }) => {
      requests.push(`${request.method} ${request.path}`)
      if (request.path === "messages") {
        queries.push(request.query)
        return { messages: [{ id: "m1" }, { id: "gone" }, ...(request.query?.includeSpamTrash === true ? [{ id: "spam" }] : [])] }
      }
      if (request.path === "messages/gone/trash") throw Object.assign(new Error("Not Found"), { status: 404 })
      return {}
    }
    const query = 'label:"Shop/Deals" older_than:14d -is:starred -in:trash'
    const agent = configured({ labels: { "Shop/Deals": {} }, cleanup: { promotions: { label: "Shop/Deals", olderThan: 14 } }, client, dryRun: false, trashEnabled: true })
    await expect(cleanupLabeller(agent, { apply: true })).resolves.toEqual({
      applied: true,
      rules: [{ messageIds: ["m1", "gone", "spam"], query, rule: "promotions" }],
    })
    expect(queries).toEqual([{ includeSpamTrash: true, maxResults: 500, q: query }])
    expect(requests).toEqual(["GET messages", "POST messages/m1/trash", "POST messages/gone/trash", "POST messages/spam/trash"])
  })

  it.each([
    [{ receipts: { label: "Missing", olderThan: 30 } }, /undeclared label/],
    [{ receipts: { label: "Receipts", olderThan: 0 } }, /positive whole number/],
    [{ receipts: { label: "Receipts", olderThan: 1.5 } }, /positive whole number/],
    [[], /cleanup must be an object/],
  ])("rejects invalid cleanup %j", async (cleanup, error) => {
    const attempt = Promise.resolve().then(() => runAgentWithContext(configured({ cleanup }), { runtime: "unknown", memo: () => undefined, waitUntil: () => {} } as never, { prompt: "test" }))
    await expect(attempt).rejects.toThrow(error)
  })
})
