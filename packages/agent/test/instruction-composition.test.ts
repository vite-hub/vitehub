import { dirname, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import {
  composeInstructionDocument,
  resolveInstructionImports,
} from "../src/instruction-composition.ts"

function importReader(files: Map<string, string>) {
  return (specifier: string, importer: string) => {
    const file = resolve(dirname(importer), specifier)
    const content = files.get(file)
    if (content === undefined) throw new Error(`Missing test file: ${file}`)
    return { content, file }
  }
}

describe("instruction composition", () => {
  it("expands relative markdown imports outside code spans and fences", () => {
    const files = new Map([
      ["/agent/nested.md", "Nested\n@./policy.md"],
      ["/agent/policy.md", "Policy"],
    ])

    expect(resolveInstructionImports([
      "Base",
      "@./nested.md",
      "`@./ignored.md`",
      "``@./ignored.md``",
      "```",
      "@./ignored.md",
      "```",
    ].join("\n"), {
      file: "/agent/instructions.md",
      read: importReader(files),
    })).toBe([
      "Base",
      "Nested",
      "Policy",
      "`@./ignored.md`",
      "``@./ignored.md``",
      "```",
      "@./ignored.md",
      "```",
    ].join("\n"))
  })

  it("renders condition chains and context bindings without executing JavaScript", () => {
    const document = [
      "Hello {{ context.customerName }}.",
      "{{{ context.supportPolicy }}}",
      "::if{if=\"context.audience === 'technical' && !context.portal\"}",
      "Use technical detail.",
      "::else-if{context.audience === 'support'}",
      "Use support detail.",
      "::else",
      "Use fallback detail.",
      "::",
    ].join("\n")

    expect(composeInstructionDocument(document, {
      context: {
        audience: "technical",
        customerName: "Acme",
        supportPolicy: "## Policy\nUse trusted policy.",
      },
    })).toBe([
      "Hello Acme.",
      "## Policy",
      "Use trusted policy.",
      "Use technical detail.",
    ].join("\n"))
  })

  it("rejects unsafe expressions and non-scalar double bindings", () => {
    expect(() => composeInstructionDocument("::if{process.exit()}\nNo\n::"))
      .toThrow("Unsafe instruction condition")
    expect(() => composeInstructionDocument("{{ context.customer }}", { context: { customer: { name: "Acme" } } }))
      .toThrow("must resolve to a scalar")
    expect(() => resolveInstructionImports("@https://example.com/policy.md", {
      file: "/agent/instructions.md",
      read: importReader(new Map()),
    })).toThrow("must be a relative file path")
    expect(() => resolveInstructionImports("@./*.md", {
      file: "/agent/instructions.md",
      read: importReader(new Map()),
    })).toThrow("cannot use globs")
  })
})
