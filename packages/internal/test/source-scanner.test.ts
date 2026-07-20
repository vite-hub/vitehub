import { describe, expect, it } from "vitest"

import {
  findDefaultExportCall,
  findIdentifierCalls,
  readObjectProperty,
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
      `  defineThingWithComment(value: string) /* hint */ { return value }`,
      `}`,
      `const real = defineThing("real")`,
      `const commented = defineThingWithComment("real")`,
    ].join("\n"), "defineThing")
    const commentedCalls = findIdentifierCalls([
      `class Fixture {`,
      `  defineThingWithComment(value: string) /* hint */ { return value }`,
      `}`,
      `const real = defineThingWithComment("real")`,
    ].join("\n"), "defineThingWithComment")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.arguments).toEqual(["\"real\""])
    expect(commentedCalls).toHaveLength(1)
    expect(commentedCalls[0]?.arguments).toEqual(["\"real\""])
  })

  it("keeps generic arrow function commas inside one argument", () => {
    expect(splitTopLevel(`<T, U>(ctx: T) => ctx, { id: "daily" }`)).toEqual([
      `<T, U>(ctx: T) => ctx`,
      `{ id: "daily" }`,
    ])
    expect(splitTopLevel(`<T, U>/* hint */(ctx: T) => ctx, { id: "daily" }`)).toEqual([
      `<T, U>/* hint */(ctx: T) => ctx`,
      `{ id: "daily" }`,
    ])
  })

  it("keeps comparison operators structural while splitting arguments", () => {
    expect(splitTopLevel(`() => a < b, { id: "daily" }`)).toEqual([
      `() => a < b`,
      `{ id: "daily" }`,
    ])
    expect(splitTopLevel(`() => a > b, { id: "daily" }`)).toEqual([
      `() => a > b`,
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

    expect(splitTopLevel(`() => { if (ready) /\\)/.test(")") }, { id: "daily" }`)).toEqual([
      `() => { if (ready) /\\)/.test(")") }`,
      `{ id: "daily" }`,
    ])

    expect(splitTopLevel(`() => { if ((ready)) /\\)/.test(")") }, { id: "daily" }`)).toEqual([
      `() => { if ((ready)) /\\)/.test(")") }`,
      `{ id: "daily" }`,
    ])

    expect(splitTopLevel(`() => { return await /\\)/.test(")") }, { id: "daily" }`)).toEqual([
      `() => { return await /\\)/.test(")") }`,
      `{ id: "daily" }`,
    ])

    expect(splitTopLevel(`() => { if /* hint */ (ready) /\\)/.test(")") }, { id: "daily" }`)).toEqual([
      `() => { if /* hint */ (ready) /\\)/.test(")") }`,
      `{ id: "daily" }`,
    ])

    expect(splitTopLevel(`() => { if (url === "http://x") /\\)/.test(")") }, { id: "daily" }`)).toEqual([
      `() => { if (url === "http://x") /\\)/.test(")") }`,
      `{ id: "daily" }`,
    ])

    expect(splitTopLevel(`() => { if (ready) /* hint */ /\\)/.test(")") }, { id: "daily" }`)).toEqual([
      `() => { if (ready) /* hint */ /\\)/.test(")") }`,
      `{ id: "daily" }`,
    ])

    expect(splitTopLevel(`() => { try {} catch (error) /\\)/.test(")") }, { id: "daily" }`)).toEqual([
      `() => { try {} catch (error) /\\)/.test(")") }`,
      `{ id: "daily" }`,
    ])
  })

  it("ignores member calls with matching names", () => {
    const calls = findIdentifierCalls([
      `logger.defineThing("member")`,
      `logger?.defineThing("optional-member")`,
      `const real = defineThing("real")`,
    ].join("\n"), "defineThing")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.arguments).toEqual(["\"real\""])
  })

  it("finds identifier calls separated from parentheses by comments", () => {
    const calls = findIdentifierCalls([
      `const first = defineThing/* @__PURE__ */("commented")`,
      `const second = defineThing<string>// generic hint`,
      `("generic")`,
    ].join("\n"), "defineThing")

    expect(calls).toHaveLength(2)
    expect(calls[0]?.arguments).toEqual(["\"commented\""])
    expect(calls[1]?.arguments).toEqual(["\"generic\""])
  })

  it("does not treat division operators as regex literals after identifiers", () => {
    expect(splitTopLevel(`() => { const ratio = a / b }, { id: "daily" }`)).toEqual([
      `() => { const ratio = a / b }`,
      `{ id: "daily" }`,
    ])
  })

  it("keeps nested template literals non-structural while splitting arguments", () => {
    expect(splitTopLevel("() => `x ${`y)`}` , { id: \"daily\" }")).toEqual([
      "() => `x ${`y)`}`",
      "{ id: \"daily\" }",
    ])
  })

  it("keeps regex literals inside template expressions non-structural", () => {
    const call = findDefaultExportCall([
      `export default defineThing({`,
      "  handler: () => `${/}``/.test(\"}\")}` ,",
      `  value: "real",`,
      `})`,
    ].join("\n"), ["defineThing"])

    expect(call).toMatchObject({
      name: "defineThing",
    })
    expect(readObjectProperty(call!.argument, "value")).toBe(`"real"`)
  })

  it("scans control-flow regex literals inside template expressions without recursion", () => {
    const call = findDefaultExportCall([
      `export default defineThing({`,
      "  handler: () => `${(() => { if (ready) /\\}/.test(\"}\") })()}` ,",
      `  value: "real",`,
      `})`,
    ].join("\n"), ["defineThing"])

    expect(call).toMatchObject({ name: "defineThing" })
    expect(readObjectProperty(call!.argument, "value")).toBe(`"real"`)
  })

  it("does not repeatedly rescan control-flow regex literals inside template expressions", () => {
    const checks = Array.from({ length: 12 }, (_, index) => `if (ready${index}) /\\}/.test("}")`).join("; ")
    const call = findDefaultExportCall([
      `export default defineThing({`,
      `  handler: () => \`${"${"}(() => { ${checks} })()}\` ,`,
      `  value: "real",`,
      `})`,
    ].join("\n"), ["defineThing"])

    expect(call).toMatchObject({ name: "defineThing" })
    expect(readObjectProperty(call!.argument, "value")).toBe(`"real"`)
  })

  it("shares regex classifications while matching nested template conditions", () => {
    const call = findDefaultExportCall([
      `export default defineThing({`,
      "  handler: () => `${(() => { if (`${(() => { if (inner) /\\}/.test(\"}\") })()}`) /\\}/.test(\"}\") })()}` ,",
      `  value: "real",`,
      `})`,
    ].join("\n"), ["defineThing"])

    expect(call).toMatchObject({ name: "defineThing" })
    expect(readObjectProperty(call!.argument, "value")).toBe(`"real"`)
  })

  it("finds default-exported definition calls", () => {
    const call = findDefaultExportCall([
      `const ignored = defineThing({ value: "ignored" })`,
      `export default (defineThing<{ value: string }>({`,
      `  value: "real",`,
      `}))`,
    ].join("\n"), ["defineThing"])

    expect(call).toMatchObject({
      argument: `{\n  value: "real",\n}`,
      name: "defineThing",
    })
  })

  it("preserves source offsets after astral Unicode characters", () => {
    const call = findDefaultExportCall([
      `// 😀`,
      `export default defineThing({ value: "real" })`,
    ].join("\n"), ["defineThing"])

    expect(call).toMatchObject({
      argument: `{ value: "real" }`,
      name: "defineThing",
    })
  })

  it("finds default exports after regex literals followed by division", () => {
    const call = findDefaultExportCall([
      `const value = /x/ / parts`,
      `export default defineThing({ value: "real" })`,
    ].join("\n"), ["defineThing"])

    expect(call?.argument).toBe(`{ value: "real" }`)
  })

  it("finds default exports after division from keyword-named members", () => {
    const call = findDefaultExportCall([
      `const value = metrics.return / total`,
      `export default defineThing({ value: "real" })`,
    ].join("\n"), ["defineThing"])

    expect(call?.argument).toBe(`{ value: "real" }`)
  })

  it("finds default exports with division after literals", () => {
    const call = findDefaultExportCall([
      `export default defineThing({`,
      `  handler: () => "ok" / total,`,
      `  value: "real",`,
      `})`,
    ].join("\n"), ["defineThing"])

    expect(readObjectProperty(call!.argument, "value")).toBe(`"real"`)
  })

  it("finds default-exported object literals with TypeScript assertions", () => {
    for (const suffix of ["as const", "satisfies ThingOptions"]) {
      const call = findDefaultExportCall(
        `export default defineThing({ value: "real" } ${suffix})`,
        ["defineThing"],
      )

      expect(call?.argument).toBe(`{ value: "real" }`)
    }
  })

  it("reads top-level object properties without matching nested values", () => {
    expect(readObjectProperty(`{ nested: { cron: "wrong" }, cron: "0 8 * * *" }`, "cron"))
      .toBe(`"0 8 * * *"`)
  })
})
