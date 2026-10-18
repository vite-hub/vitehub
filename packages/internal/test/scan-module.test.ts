import { describe, expect, it } from "vitest"

import {
  dynamic,
  findCalls,
  findDefaultExportCall,
  findProperty,
  maskLiterals,
  moduleTokens,
  objectProperties,
  scanModule,
  staticValue,
  templateExpressionSources,
} from "../src/build/scan-module.ts"

import type { Expression } from "../src/build/scan-module.ts"

function expression(source: string): Expression {
  const statement = scanModule(`(${source})`).program.body[0]
  if (statement?.type !== "ExpressionStatement") throw new Error("expected an expression")
  return statement.expression
}

describe("scanModule", () => {
  it("finds the default export call and its options through parentheses and assertions", () => {
    const module = scanModule("const first = <Email>value;\nexport default (defineThing({ value: \"real\" } as const))\nconst pattern = /}{/g")
    const definition = findDefaultExportCall(module, ["defineThing"])
    expect(definition?.name).toBe("defineThing")
    expect(definition?.options && staticValue(definition.options)).toEqual({ value: "real" })
  })

  it("reads positional options only from calls with more than one argument", () => {
    const positional = findDefaultExportCall(scanModule("export default defineThing('cron', () => {}, { manual: true })"), ["defineThing"], { positionalOptionsIndex: 2 })
    expect(positional?.options && staticValue(positional.options)).toEqual({ manual: true })
    const withoutOptions = findDefaultExportCall(scanModule("export default defineThing('cron', () => {})"), ["defineThing"], { positionalOptionsIndex: 2 })
    expect(withoutOptions).toMatchObject({ name: "defineThing" })
    expect(withoutOptions?.options).toBeUndefined()
    expect(findDefaultExportCall(scanModule("export default defineThing({ value: 1 } as Foo - other)"), ["defineThing"], { positionalOptionsIndex: 2 })).toBeUndefined()
  })

  it("reads JSX files with regular expressions after elements", () => {
    const module = scanModule("const result = <Email></Email> * /['\"]/u\nexport default defineThing({ value: \"real\" })", "source.tsx")
    expect(module.errors).toEqual([])
    expect(findDefaultExportCall(module, ["defineThing"])).toBeDefined()
  })

  it("ignores member calls and declarations with the same name", () => {
    const module = scanModule("function defineThing() {}\nobject.defineThing({})\nclass A { defineThing() {} }\ndefineThing({ value: 1 })")
    expect(findCalls(module, ["defineThing"]).map(call => call.start)).toEqual([module.source.lastIndexOf("defineThing")])
  })
})

describe("staticValue", () => {
  it.each([
    ["\"text\"", "text"],
    ["`text`", "text"],
    ["-1", -1],
    ["true", true],
    ["null", null],
    ["undefined", undefined],
    ["void 0", undefined],
    ["[1, \"two\"]", [1, "two"]],
    ["{ a: { b: [false] } } satisfies Options", { a: { b: [false] } }],
  ])("reads the literal %s", (source, value) => {
    expect(staticValue(expression(source))).toEqual(value)
  })

  it.each(["`a${b}`", "value", "\"a\" + \"b\"", "{ ...rest }", "{ [key]: 1 }", "{ method() {} }", "/pattern/", "[...items]", String.raw`"\8"`, String.raw`'\01'`, String.raw`'\u00GG'`])("returns dynamic for %s", (source) => {
    expect(staticValue(expression(source))).toBe(dynamic)
  })

  it("reports static keys, computed keys, and spreads", () => {
    const object = expression("{ plain: 1, \"quoted\": 2, [\"computed\"]: 3, [key]: 4, ...rest, 42n: 5 }")
    if (object.type !== "ObjectExpression") throw new Error("expected an object")
    expect(objectProperties(object).map(property => [property.key, property.computed])).toEqual([
      ["plain", false],
      ["quoted", false],
      ["computed", true],
      [undefined, true],
      [undefined, false],
      ["42", false],
    ])
    expect(findProperty(object, "quoted")?.value).toMatchObject({ type: "Literal", value: 2 })
  })
})

describe("maskLiterals", () => {
  it("masks comments and literals and keeps positions and line breaks", () => {
    const source = "const a = \"}\" // }\nconst b = /}/g\nconst c = `}${d}`\n"
    const masked = maskLiterals(scanModule(source))
    expect(masked).toHaveLength(source.length)
    expect(masked.split("\n")).toHaveLength(source.split("\n").length)
    expect(masked).not.toContain("}")
  })
})

describe("moduleTokens", () => {
  it("keeps literals whole and splits division from regular expressions", () => {
    const { lineBreaks, tokens } = moduleTokens(scanModule("const a = b / c / d\nconst r = /x\\/y/g // note\nconst t = `a${`b${c}`}`\nconst \\u0061b = 1"))
    expect(tokens).toEqual([
      "const", "a", "=", "b", "/", "c", "/", "d",
      "const", "r", "=", "/x\\/y/g",
      "const", "t", "=", "`a${`b${c}`}`",
      "const", "ab", "=", "1",
    ])
    expect([...lineBreaks]).toEqual([8, 12, 16])
  })

  it("lists template substitutions without their delimiters", () => {
    expect(templateExpressionSources("`a${ b }c${`d${e}`}`")).toEqual([" b ", "`d${e}`"])
  })
})
