import { createRecord } from "@diglot/core"
import { describe, expect, it } from "vitest"

import { findPreviousTranslations, similarity } from "../src/lineage.ts"
import { messageId, messageSegment } from "../src/records.ts"

import type { SourceMessages } from "../src/manifest.ts"
import type { TranslationRecords } from "../src/records.ts"

function messages(...texts: Array<string | [string, string]>): SourceMessages {
  return Object.fromEntries(texts.map((text) => {
    const [message, context] = Array.isArray(text) ? text : [text, undefined]
    return [messageId(message, context), { message, ...(context ? { context } : {}), hash: messageSegment(message, context).hash, origins: [] }]
  }))
}

function records(entries: Record<string, string>, context?: string): TranslationRecords {
  return Object.fromEntries(Object.entries(entries).map(([source, translation]) =>
    [messageId(source, context), createRecord({ segment: messageSegment(source, context), text: translation, origin: "human" })]))
}

describe("previous translations of changed messages", () => {
  it("scores close texts high and different texts low", () => {
    expect(similarity("Search agents", "Search all agents")).toBeGreaterThan(0.8)
    expect(similarity("Search agents", "Delete your account")).toBeLessThan(0.3)
  })

  it("matches a changed message to the record it replaced, once", () => {
    const code = messages("Search all agents", "Deploy your agent now", "Delete your account")
    const stored = records({ "Search agents": "Buscar agentes", "Deploy your agent": "Despliega tu agente", "Save": "Guardar" })
    const previous = findPreviousTranslations(code, stored)
    expect(previous.get(messageId("Search all agents"))).toMatchObject({ id: messageId("Search agents"), record: { text: "Buscar agentes" } })
    expect(previous.get(messageId("Deploy your agent now"))).toMatchObject({ record: { text: "Despliega tu agente" } })
    expect(previous.has(messageId("Delete your account"))).toBe(false)
    expect(previous.size).toBe(2)
  })

  it.each([false, true])("keeps both viable matches when messages compete for a record (reversed: %s)", (reversed) => {
    const texts = ["Search agents today", "Search available agents today"]
    const code = messages(...(reversed ? texts.reverse() : texts))
    const stored = records({ "Search agents": "Buscar agentes", "Search agents now": "Buscar agentes ahora" })
    const previous = findPreviousTranslations(code, stored)
    expect(previous.size).toBe(2)
    expect(previous.get(messageId("Search agents today"))?.id).toBe(messageId("Search agents now"))
    expect(previous.get(messageId("Search available agents today"))?.id).toBe(messageId("Search agents"))
  })

  it.each(["rejected", "invalid", "visible"])("treats a %s current record according to its visibility", (state) => {
    const next = "Search all {0} agents"
    const stored = records({ "Search {0} agents": "Buscar {0} agentes" })
    stored[messageId(next)] = createRecord({
      segment: messageSegment(next),
      text: state === "invalid" ? "Buscar agentes" : "Buscar todos los {0} agentes",
      origin: "human",
      ...(state === "rejected" ? { review: "rejected", rejectedBy: { by: "ana", at: "2026-11-07T10:00:00.000Z" } } : {}),
    })
    const previous = findPreviousTranslations(messages(next), stored)
    if (state === "visible") expect(previous.size).toBe(0)
    else expect(previous.get(messageId(next))).toMatchObject({ id: messageId("Search {0} agents") })
  })

  it("needs the same context and the same placeholders", () => {
    expect(findPreviousTranslations(messages(["Save draft", "button"]), records({ "Save drafts": "Guardar borradores" })).size).toBe(0)
    expect(findPreviousTranslations(messages(["Save draft", "button"]), records({ "Save drafts": "Guardar borradores" }, "button")).size).toBe(1)
    expect(findPreviousTranslations(messages(["Save draft", "button"]), records({ "Save drafts": "Guardar borradores" }, "menu")).size).toBe(0)
    expect(findPreviousTranslations(messages("Hello {name}, welcome"), records({ "Hello {user}, welcome": "Hola {user}" })).size).toBe(0)
    expect(findPreviousTranslations(messages("Read the <0>docs</0> first"), records({ "Read the <0>docs</0>": "Lee la <0>documentación</0>" })).size).toBe(1)
  })

  it.each([
    ["{role, select, admin {Admin} other {Member}}", "{role, select, admin {Administrator} other {Member}}"],
    ["{count, plural, one {A deployment} other {# deployments}}", "{count, plural, one {One deployment} other {# deployments}}"],
    ["{rank, selectordinal, one {First place} other {#th place}}", "{rank, selectordinal, one {Top place} other {#th place}}"],
    ["Hello '{name}' {user}", "Hello '{nickname}' {user}"],
  ])("matches edits to ICU literal text: %s", (source, next) => {
    expect(findPreviousTranslations(messages(next), records({ [source]: source })).get(messageId(next)))
      .toMatchObject({ id: messageId(source) })
  })

  it.each([
    ["{count, plural, one {total} other {Deployments for {user}}}", "{total, plural, one {count} other {Deployments for {user}}}"],
    ["{count, plural, one {A deployment for {user}} other {# deployments}}", "{count, plural, one {A deployment for {owner}} other {# deployments}}"],
    ["{role, select, admin {<0>Admin</0>} other {Member}}", "{role, select, admin {<1>Admin</1>} other {Member}}"],
  ])("rejects changed ICU arguments or tags: %s", (source, next) => {
    expect(similarity(source, next)).toBeGreaterThan(0.6)
    expect(findPreviousTranslations(messages(next), records({ [source]: source })).size).toBe(0)
  })

  it.each([
    ["Hello {name}", "Hello {name}, {count, plural, one {Hi}"],
    ["Hello {name}, {count, plural, one {Hi}", "Hello {name}"],
    ["Hello {name}, {count, plural, one {Hi}", "Hello {name}, {count, plural, one {Welcome}"],
  ])("skips invalid ICU without interrupting matching: %s", (source, next) => {
    const previous = findPreviousTranslations(messages(next, "Search all agents"), records({ [source]: source, "Search agents": "Buscar agentes" }))
    expect([...previous.keys()]).toEqual([messageId("Search all agents")])
  })

  it("skips rejected or invalid translations", () => {
    const stored = records({ "Search agents": "Buscar agentes", "Hello {name}": "Hola" })
    stored[messageId("Search agents")] = createRecord({
      segment: messageSegment("Search agents"),
      text: "Buscar agentes",
      origin: "mt",
      review: "rejected",
      rejectedBy: { by: "ana", at: "2026-11-07T10:00:00.000Z" },
    })
    expect(findPreviousTranslations(messages("Search all agents", "Hello {name}, welcome"), stored).size).toBe(0)
  })
})
