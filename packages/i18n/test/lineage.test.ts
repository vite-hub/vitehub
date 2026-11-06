import { describe, expect, it } from "vitest"

import { findPreviousTranslations, similarity } from "../src/lineage.ts"
import { messageId } from "../src/records.ts"

import type { SourceMessages } from "../src/manifest.ts"
import type { TranslationRecords } from "../src/records.ts"

function messages(...texts: Array<string | [string, string]>): SourceMessages {
  return Object.fromEntries(texts.map((text) => {
    const [message, context] = Array.isArray(text) ? text : [text, undefined]
    return [messageId(message, context), { message, ...(context ? { context } : {}), origins: [] }]
  }))
}

function records(entries: Record<string, string>, context?: string): TranslationRecords {
  return Object.fromEntries(Object.entries(entries).map(([source, translation]) =>
    [messageId(source, context), { source, translation, ...(context ? { context } : {}) }]))
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
    expect(previous.get(messageId("Search all agents"))).toMatchObject({ id: messageId("Search agents"), record: { translation: "Buscar agentes" } })
    expect(previous.get(messageId("Deploy your agent now"))).toMatchObject({ record: { translation: "Despliega tu agente" } })
    expect(previous.has(messageId("Delete your account"))).toBe(false)
    expect(previous.size).toBe(2)
  })

  it("needs the same context and the same placeholders", () => {
    expect(findPreviousTranslations(messages(["Save draft", "button"]), records({ "Save drafts": "Guardar borradores" })).size).toBe(0)
    expect(findPreviousTranslations(messages("Hello {name}, welcome"), records({ "Hello {user}, welcome": "Hola {user}" })).size).toBe(0)
    expect(findPreviousTranslations(messages("Read the <0>docs</0> first"), records({ "Read the <0>docs</0>": "Lee la <0>documentación</0>" })).size).toBe(1)
  })
})
