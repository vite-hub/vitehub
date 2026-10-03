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

  it.each([
    "satisfies { config: Record<string, unknown>; extra: Map<string, unknown> }",
    "as (Record<string, unknown>)",
    "satisfies (Record<string, unknown>)",
    "satisfies import(\"types\").Record<string, unknown>",
    "as [Record<string, unknown>]",
    "satisfies First<string, unknown> & Second<string, unknown>",
    "as First<string, unknown> | Second<string, unknown>",
    "as true extends true ? Options<string, unknown> : never",
    "as true extends true ? readonly Other<string, unknown>[] : never",
    "as true extends true ? keyof Other<string, unknown> : never",
    "as true extends true ? ScheduleDefinitionInput : keyof (Options<string, unknown>)",
    'as true extends true ? ScheduleDefinitionInput : `${Extract<"a" | "b", string>}`',
    'as `${Extract<"a" | "b", string>}`',
    "as false extends true ? never : Options<string, unknown>",
    "as false extends true ? never : Types.Options<string, unknown>",
    "as true extends true ? keyof /* branch */ Types.Options<string, unknown> : never",
    "as true extends true ? ScheduleDefinitionInput : { config: string, other: number }",
    "as true extends true ? { config: string, other: number } : ScheduleDefinitionInput",
    "as true extends true ? ScheduleDefinitionInput : [config: string, other: number]",
    "as true extends true ? ScheduleDefinitionInput : ((config: string, other: number) => void)",
    "as keyof Record<string, unknown> extends PropertyKey ? Definition : never",
    "as unknown as T extends Types.Promise<string, unknown> ? Definition : never",
    "as unknown as T extends keyof Types.Promise<string, unknown> ? Definition : never",
    "as unknown as typeof shape<string, unknown>",
    "as unknown as typeof /* value */ shapes.schedule /* args */ <string, unknown>",
    "as unknown as () => { config: Record<string, unknown> }",
    "as unknown as new () => { config: Record<string, unknown> }",
    "as unknown as () => [config: Record<string, unknown>, extra: string]",
    "as unknown as new () => [config: Record<string, unknown>, extra: string]",
    "as unknown as () => ({ config: Record<string, unknown> })",
    "as unknown as () => (Result<string, unknown>)",
    "as unknown as () => ((Result<string, unknown>))",
    "as unknown as () => ((value: string) => { config: Record<string, unknown> })",
    "as unknown as () => /* return */ { config: Record<string, unknown> }",
    "as unknown as () => () => { config: Record<string, unknown> }",
    "as unknown as () => Result<string, unknown>",
    "as unknown as new () => Result<string, unknown>",
    "as unknown as (value: unknown) => asserts value is Result<string, unknown>",
    "as unknown as (value: unknown) => value is Result<string, unknown>",
    "as unknown as (value: unknown) => this is Result<string, unknown>",
    "as unknown as () => readonly Result<string, unknown>[]",
    "as unknown as () => keyof Result<string, unknown>",
    "as unknown as () => typeof shape<string, unknown>",
    "as unknown as () => Result<string, unknown> & Types.Other<number, boolean>",
    "as unknown as () => Result<string, unknown> | Other<number, boolean>",
    "as unknown as (callback: (value: string) => void) => Result<string, unknown>",
    "as unknown as (value: unknown) => value is Result<string, unknown> | Other<number, boolean>",
    "as unknown as (value: unknown) => asserts value is Result<string, unknown> & Types.Other<number, boolean>",
    "as unknown as (value: unknown) => this is Result<string, unknown> | Other<number, boolean>",
    "as unknown as (value: unknown) => value is Result<string, unknown> | /* member */ 类型<number, boolean>",
    "as unknown as T extends infer 类型 extends Pair<string, unknown> ? Definition : never",
    "as unknown as T extends infer 类型 extends 命名空间.类型<string, unknown> ? Definition : never",
    "as unknown as T extends infer R extends Pair<string, unknown> ? Definition : never",
    "as unknown as T extends infer \\u0052 extends Pair<string, unknown> ? Definition : never",
    "as unknown as T extends 类型<string, unknown> ? Definition : never",
    "as unknown as T extends 命名空间.类型<string, unknown> ? Definition : never",
    "as unknown as T extends keyof /* constraint */ 命名空间.类型<string, unknown> ? Definition : never",
    "as unknown as T extends infer R extends 类型<string, unknown> ? Definition : never",
    "as keyof /* type */ Record<string, unknown>",
    "as Options<string, unknown> extends Base<string, unknown> ? (Options<string, unknown>) : [Options<string, unknown>]",
    "as true extends true ? false extends true ? never : Options<string, unknown> : never",
    'satisfies import("types", { with: { "resolution-mode": "import" } }).Record<string, unknown>',
    'as import /* type */ ("types" /* module */, /* attributes */ { with: { "resolution-mode": "require" } } /* end */).Record<string, unknown>',
    'satisfies import /* type */ ("types" /* module */).Record<string, unknown>',
    'as import // type\n ("types" /* module */).Record<string, unknown>',
    "as 𐀀Type<string, unknown>",
    "as Type𐀀<string, unknown> | Other<string, unknown>",
    "as unknown as T extends 𐀀Type<string, unknown> ? Definition : never",
    "as unknown as T extends (Pair<string, unknown>) ? Definition : never",
    "as unknown as T extends ((Pair<string, unknown>)) ? Definition : never",
    "as unknown as T extends /* constraint */ (Pair<string, unknown>) ? Definition : never",
    "as unknown as T extends infer 𐀀Type extends Pair<string, unknown> ? Definition : never",
    "as 类型<string, unknown>",
    "as 类型<string, unknown> | Other<string, unknown>",
    "satisfies 类型<string, unknown> & Other<string, unknown>",
    "as 类型<string, unknown> | Другой<string, unknown>",
    "as unknown as (value: unknown) => value is Result<string, unknown> & Other<string, unknown>",
    "as unknown as (value: unknown) => value is (Result<string, unknown>)",
    "as \\u0066oo<string, unknown>",
  ])("keeps nested generic assertion commas inside one argument: %s", (assertion) => {
    const argument = `{ cron: '0 8 * * *' } ${assertion}`
    expect(splitTopLevel(`${argument}, second`)).toEqual([argument, "second"])
    expect(findDefaultExportCall(`export default defineSchedule(${argument})`, ["defineSchedule"])?.arguments)
      .toEqual([argument])
  })

  it.each([
    "satisfies Record<string, unknown>",
    "as Record<string, unknown>",
    "as const satisfies Record<string, Map<string, unknown>>",
    "satisfies /* type */ Types.Record /* args */ <string, unknown>",
    "satisfies f\\u006Fo<string, unknown>",
    "satisfies foo\\u006f<string, unknown>",
    "satisfies foo\\u{006f}<string, unknown>",
    "satisfies f\\u{006f}o<string, unknown>",
    "satisfies \\u{010000}Type<string, unknown>",
  ])("keeps generic assertion commas inside one argument: %s", (assertion) => {
    const argument = `{ cron: '0 8 * * *', handler: () => {} } ${assertion}`
    expect(splitTopLevel(`${argument}, second`)).toEqual([argument, "second"])
    expect(findDefaultExportCall(`export default defineSchedule(${argument})`, ["defineSchedule"])?.arguments)
      .toEqual([argument])
  })

  it.each([
    "value as number < lower, upper > 0",
    "value as Foo < lower, upper > 0",
    "value satisfies number < lower, upper > 0",
    "value as true < lower, upper > false",
    "value as false < lower, upper > true",
    "value as this < lower, upper > true",
    "value as 1n < lower, upper > 0n",
    "value as foo\\u{110000}<lower, upper>0",
    "object.as.Record < lower, upper > 0",
    "object.satisfies.Record < lower, upper > 0",
    "value as const, left < lower, upper > 0",
  ])("does not treat comparisons after assertion-like tokens as generics: %s", (expression) => {
    expect(splitTopLevel(expression)).toEqual(expression.split(", "))
  })

  it("keeps generic arguments after a parenthesized conditional union assertion", () => {
    const argument = `{ cron: '0 8 * * *' } as unknown as (true extends true ? Definition : Other) | Last<string, unknown>`
    expect(splitTopLevel(`${argument}, second`)).toEqual([argument, "second"])
    expect(findDefaultExportCall(`export default defineSchedule(${argument})`, ["defineSchedule"])?.arguments)
      .toEqual([argument])
  })

  it.each(["|| fallback", "+ extra", " > limit", "(argument)", " ^ bar()", " ^ (bar())", " - (bar())"])("rejects runtime suffixes after generic assertions: %s", (suffix) => {
    expect(findDefaultExportCall(`export default defineSchedule({ cron: '0 8 * * *' } satisfies Record<string, unknown>${suffix})`, ["defineSchedule"]))
      .toBeUndefined()
  })

  it.each([
    "satisfies (Record<string, unknown>)(argument)",
    "as { config: Record<string, unknown> } || fallback",
    'satisfies import("types").Record<string, unknown> + extra',
    "as (number) < lower, upper > 0",
    "as Options<string, unknown> ? (bar()) : fallback",
    "as unknown as () => { config: Record<string, unknown> } + fallback",
    "as unknown as new () => [config: Record<string, unknown>] (argument)",
    "as unknown as () => { config: string } ? fallback : alternate",
    "as unknown as () => (Result<string, unknown> + fallback)",
    "as unknown as new () => ((Result<string, unknown> || fallback))",
    "as unknown as () => (Result<string, unknown> (argument))",
    "as unknown as () => (Result<string, unknown> ? fallback : alternate)",
    "as (Result<string, unknown> + fallback)",
    "as unknown as () => (Result<string, unknown> ^ (bar()))",
    "as unknown as () => Result<string, unknown> + fallback",
    "as unknown as () => Result<string, unknown> || fallback",
    "as unknown as () => Result<string, unknown> ? fallback : alternate",
    "as unknown as () => Result<string, unknown> (argument)",
    "as Foo `tag`",
    "as Foo<string> `tag`",
    "as unknown as new () => Result<string, unknown> + fallback",
    "as unknown as new () => Result<string, unknown> || fallback",
    "as unknown as new () => Result<string, unknown> ? fallback : alternate",
    "as unknown as new () => Result<string, unknown> (argument)",
    "as unknown as (value: unknown) => asserts value is Result<string, unknown> + fallback",
    "as unknown as (value: unknown) => asserts value is Result<string, unknown> || fallback",
    "as unknown as (value: unknown) => asserts value is Result<string, unknown> ? fallback : alternate",
    "as unknown as (value: unknown) => asserts value is Result<string, unknown> (argument)",
    "as T extends (Pair<string, unknown> + fallback) ? Definition : never",
    "as T extends (Pair<string, unknown>(argument)) ? Definition : never",
    "as Definition ? fallback : fallback",
    "as Options<string, unknown> ? fallback : fallback",
    "as true extends true ? Definition : never ? fallback : fallback",
    "as Definition ? { config: string, other: number } : fallback",
    "as true extends true ? Definition : never ? (bar()) : fallback",
    "as true extends true ? Options<string, unknown> : never ? (bar()) : fallback",
    "as Types /* marker */ . extends ? fallback : alternate",
  ])("rejects runtime suffixes after nested assertion types: %s", (assertion) => {
    expect(findDefaultExportCall(`export default defineSchedule({ cron: '0 8 * * *' } ${assertion})`, ["defineSchedule"]))
      .toBeUndefined()
  })

  it.each([">fallback", ">>fallback", ">>>fallback", ">=fallback", "<fallback", "<<fallback", "<=fallback"])("rejects compact relational assertions behind wrapping assertions: %s", (operator) => {
    const expression = `(({ cron: '0 8 * * *' } as Foo${operator}) as ScheduleDefinitionInput)`
    expect(findDefaultExportCall(`export default defineSchedule(${expression})`, ["defineSchedule"]))
      .toBeUndefined()
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

  it("finds positional options with nested parentheses and assertions", () => {
    for (const suffix of ["as const", "satisfies ThingOptions", "as Types.Options", "as const satisfies ThingOptions"]) {
      for (const argument of [
        `{ manual: true } ${suffix}`,
        `({ manual: true } ${suffix})`,
        `(({ manual: true }) ${suffix})`,
        `(/* options */ ({ manual: true }) /* assertion */ ${suffix} /* end */)`,
      ]) {
        const call = findDefaultExportCall(
          `export default defineThing("cron", handler, ${argument})`,
          ["defineThing"],
          { positionalOptionsIndex: 2 },
        )
        expect(call?.argument, argument).toBe("{ manual: true }")
      }
    }
  })

  it("rejects positional options with trailing expression material", () => {
    for (const suffix of [
      "as const && false",
      "as const || false",
      "as const ?? false",
      "as const + 1",
      "as const - 1",
      "as Options - Other",
      "as const * 2",
      "as const / 2",
      "as const > false",
      "as const === false",
      "as const instanceof Options",
      "as const & false",
      "as const | false",
      "as const ? false : true",
      "as Options()",
      "satisfies Options, false",
      "as",
      "satisfies",
    ]) {
      for (const argument of [
        `{ manual: true } ${suffix}`,
        `({ manual: true } ${suffix})`,
        `(({ manual: true }) ${suffix})`,
      ]) {
        const call = findDefaultExportCall(
          `export default defineThing("cron", handler, (${argument}))`,
          ["defineThing"],
          { positionalOptionsIndex: 2 },
        )
        expect(call, argument).toBeUndefined()
      }
    }
  })

  it("reads top-level object properties without matching nested values", () => {
    expect(readObjectProperty(`{ nested: { cron: "wrong" }, cron: "0 8 * * *" }`, "cron"))
      .toBe(`"0 8 * * *"`)
  })
})
