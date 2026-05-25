import { describe, expect, it } from "vitest"

import {
  findIdentifierCalls,
  splitTopLevel,
} from "../src/source-scanner.ts"

describe("source scanner", () => {
  it("finds identifier calls outside comments and strings", () => {
    const calls = findIdentifierCalls([
      `const docs = "defineThing('docs')"`,
      `const pattern = /defineThing\\)/`,
      `// defineThing('line-comment')`,
      `/* defineThing('block-comment') */`,
      `export default defineThing<string>("real", { ok: true })`,
    ].join("\n"), "defineThing")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.arguments).toEqual(["\"real\"", "{ ok: true }"])
  })

  it("ignores function declarations with matching names", () => {
    const defineCalls = findIdentifierCalls([
      `function defineThing(value: string) { return value }`,
      `const first = defineThing("real")`,
    ].join("\n"), "defineThing")
    const createCalls = findIdentifierCalls([
      `async function createThing<T>(value: T) { return value }`,
      `const second = createThing<string>("generic")`,
    ].join("\n"), "createThing")
    const streamCalls = findIdentifierCalls([
      `function* streamThing() { yield "ok" }`,
      `const third = streamThing()`,
    ].join("\n"), "streamThing")

    expect(defineCalls).toHaveLength(1)
    expect(defineCalls[0]?.arguments).toEqual(["\"real\""])
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.arguments).toEqual(["\"generic\""])
    expect(streamCalls).toHaveLength(1)
    expect(streamCalls[0]?.arguments).toEqual([""])
  })

  it("ignores method declarations with matching names", () => {
    const calls = findIdentifierCalls([
      `class Fixture {`,
      `  defineThing(value: string) { return value }`,
      `}`,
      `const real = defineThing("real")`,
    ].join("\n"), "defineThing")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.arguments).toEqual(["\"real\""])
  })

  it("keeps generic arrow function commas inside one argument", () => {
    expect(splitTopLevel(`<T, U>(ctx: T) => ctx, { id: "daily" }`)).toEqual([
      `<T, U>(ctx: T) => ctx`,
      `{ id: "daily" }`,
    ])
  })

  it("keeps regex literals non-structural while splitting arguments", () => {
    expect(splitTopLevel(`() => { return /\\)/.test(")") }, { id: "daily" }`)).toEqual([
      `() => { return /\\)/.test(")") }`,
      `{ id: "daily" }`,
    ])

    expect(splitTopLevel(`async () => { await /\\)/.test(")") }, { id: "daily" }`)).toEqual([
      `async () => { await /\\)/.test(")") }`,
      `{ id: "daily" }`,
    ])

    expect(splitTopLevel(`() => { const ok = foo + /\\)/.test(")") }, { id: "daily" }`)).toEqual([
      `() => { const ok = foo + /\\)/.test(")") }`,
      `{ id: "daily" }`,
    ])
  })

  it("does not treat division operators as regex literals after identifiers", () => {
    expect(splitTopLevel(`() => { const ratio = a / b }, { id: "daily" }`)).toEqual([
      `() => { const ratio = a / b }`,
      `{ id: "daily" }`,
    ])
  })
})
