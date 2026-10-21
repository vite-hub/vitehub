import { expect, it } from "vitest"
import { createCursorHistory } from "../src/runtime/cursor-history.ts"

it.each(["vhc:provider-cursor", "vhc:1:not-json", "vhc:1:%7B%7D", "vhc:1:%"])("preserves opaque provider cursor %s", (cursor) => {
  expect(createCursorHistory().take(cursor)).toMatchObject({ providerCursor: cursor, history: new Set([cursor]) })
})

it("preserves portable history across instances", () => {
  const cursor = createCursorHistory().store("vhc:next", new Set(["first", "vhc:next"]))
  expect(createCursorHistory().take(cursor)).toMatchObject({ providerCursor: "vhc:next", history: new Set(["first", "vhc:next"]) })
})

it("rejects a continuation owned by another storage namespace", () => {
  const cursor = createCursorHistory("cloudflare-kv").store("provider", new Set(["provider"]))
  expect(() => createCursorHistory("deno-kv").take(cursor)).toThrow("different storage backend")
})

it("rejects duplicate consumers while a continuation is in flight", () => {
  const history = createCursorHistory()
  const cursor = history.store("provider", new Set(["provider"]))
  const continuation = history.take(cursor)

  expect(() => history.take(cursor)).toThrow("already in use")

  history.restore(cursor, continuation)
  expect(history.take(cursor)).toMatchObject({ providerCursor: "provider" })
})

it("rejects duplicate consumers across history instances", () => {
  const owner = createCursorHistory()
  const other = createCursorHistory()
  const cursor = owner.store("provider", new Set(["provider"]))
  owner.take(cursor)

  expect(() => other.take(cursor)).toThrow("already in use")
})

it("bounds abandoned in-flight continuations", () => {
  const history = createCursorHistory()
  const first = history.store("provider-0", new Set(["provider-0"]))
  history.take(first)

  for (let index = 1; index <= 1_024; index++) {
    const cursor = history.store(`provider-${index}`, new Set([`provider-${index}`]))
    history.take(cursor)
  }

  expect(() => createCursorHistory().take(first)).toThrow("expired")
})

it("fails closed when another history instance evicts a continuation", () => {
  const owner = createCursorHistory()
  const other = createCursorHistory()
  const cursor = owner.store("provider", new Set(["provider"]))

  for (let index = 0; index < 1_024; index++) {
    other.store(`provider-${index}`, new Set([`provider-${index}`]))
  }

  expect(() => createCursorHistory().take(cursor)).toThrow("expired")
})

it("preserves a provider cursor that resembles the legacy continuation format", () => {
  const cursor = "vhc:1:%7B%22providerCursor%22%3A%22provider%22%2C%22history%22%3A%5B%5D%7D"
  expect(createCursorHistory().take(cursor)).toMatchObject({ providerCursor: cursor, history: new Set([cursor]) })
})

it("preserves a provider cursor that resembles the current continuation format", () => {
  const cursor = "vhc1:1:%7B%22providerCursor%22%3A%22provider%22%2C%22history%22%3A%5B%5D%7D"
  expect(createCursorHistory().take(cursor)).toMatchObject({ providerCursor: cursor, history: new Set([cursor]) })
})

it("rejects oversized raw and portable cursors before decoding", () => {
  expect(() => createCursorHistory().take(`vhc:${"x".repeat(8 * 1_024)}`)).toThrow("maximum size")
  expect(() => createCursorHistory().take(`vhc1:1:${"x".repeat(128 * 1_024)}`)).toThrow("maximum size")
})

it("keeps continuation size bounded for long cursor histories", () => {
  const history = new Set(Array.from({ length: 1_024 }, (_, index) => `${index}-${"x".repeat(200)}`))
  const cursor = createCursorHistory().store("provider", history)
  expect(cursor.length).toBeLessThan(128 * 1_024)
})
