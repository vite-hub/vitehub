import { dirname, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { applyCapabilityInstructionSlots } from "../src/capability-runtime.ts"
import {
  composeInstructionDocument,
  resolveInstructionImports,
} from "../src/instruction-composition.ts"
import { applyWorkspaceSourceInstructionSlot } from "../src/workspace-agent.ts"

function importReader(files: Map<string, string>) {
  return (specifier: string, importer: string) => {
    const file = resolve(dirname(importer), specifier)
    const content = files.get(file)
    if (content === undefined) throw new Error(`Missing test file: ${file}`)
    return { content, file }
  }
}

describe("instruction composition", () => {
  it("expands relative markdown imports outside code spans and fences", async () => {
    const files = new Map([
      ["/agent/nested.md", "Nested\n@./policy.md"],
      ["/agent/policy.md", "Policy"],
    ])

    expect(await resolveInstructionImports([
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
      "`@./ignored.md`",
      "",
      "```",
      "@./ignored.md",
      "```",
    ].join("\n"))
  })

  it("renders condition chains and context bindings without executing JavaScript", async () => {
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

    expect(await composeInstructionDocument(document, {
      context: {
        audience: "technical",
        customerName: "Acme",
        supportPolicy: "## Policy\nUse trusted policy.",
      },
    })).toBe([
      "Hello Acme.",
      "## Policy",
      "Use trusted policy.",
      "",
      "Use technical detail.",
    ].join("\n"))
  })

  it("parses boolean chains without skipping the right side", async () => {
    expect(await composeInstructionDocument([
      "::if{context.enabled && context.customerName}",
      "Enabled.",
      "::else",
      "Disabled.",
      "::",
    ].join("\n"), { context: { customerName: "Acme", enabled: false } })).toBe("Disabled.")

    expect(await composeInstructionDocument([
      "::if{context.enabled || context.customerName}",
      "Enabled.",
      "::else",
      "Disabled.",
      "::",
    ].join("\n"), { context: { customerName: "Acme", enabled: true } })).toBe("Enabled.")
  })

  it("reads stable context ids with hyphens and dotted names", async () => {
    expect(await composeInstructionDocument([
      "{{ context.llm-route.choice }}",
      "{{ context.support.customer.name }}",
    ].join("\n"), {
      context: {
        "llm-route": { choice: "fast" },
        "support.customer": { name: "Acme" },
      },
    })).toBe("fast\nAcme")
  })

  it("does not render bindings or directives inside code spans and fences", async () => {
    expect(await composeInstructionDocument([
      "Hello {{ context.name }}.",
      "`{{ context.name }}`",
      "`::if{context.enabled}`",
      "```md",
      "{{ context.name }}",
      "::if{context.enabled}",
      "Hidden",
      "::",
      "```",
    ].join("\n"), {
      context: { enabled: false, name: "Acme" },
    })).toBe([
      "Hello Acme.",
      "`{{ context.name }}`",
      "`::if{context.enabled}`",
      "",
      "```md",
      "{{ context.name }}",
      "::if{context.enabled}",
      "Hidden",
      "::",
      "```",
    ].join("\n"))
  })

  it("renders conditionals before consuming capability and source instruction slots", async () => {
    const document = [
      "::if{context.showCapability}",
      "{{ capabilities.docs }}",
      "{{ workspace.sources }}",
      "::else",
      "No capability instructions.",
      "::",
    ].join("\n")
    const baseInstructions = await composeInstructionDocument(document, {
      context: { showCapability: false },
    })

    expect(applyCapabilityInstructionSlots(baseInstructions, [
      { id: "capabilities.docs", instructions: "Use docs capability." },
    ])).toBe("No capability instructions.\n\nUse docs capability.")
    expect(applyWorkspaceSourceInstructionSlot(baseInstructions, "Use docs source."))
      .toBe("No capability instructions.\n\nUse docs source.")
  })

  it("rejects unsafe expressions and non-scalar double bindings", async () => {
    await expect(composeInstructionDocument("::if{process.exit()}\nNo\n::"))
      .rejects.toThrow("Unsafe instruction condition")
    await expect(composeInstructionDocument("{{ context.customer }}", { context: { customer: { name: "Acme" } } }))
      .rejects.toThrow("must resolve to a scalar")
    await expect(resolveInstructionImports("@https://example.com/policy.md", {
      file: "/agent/instructions.md",
      read: importReader(new Map()),
    })).rejects.toThrow("must be a relative file path")
    await expect(resolveInstructionImports("@./*.md", {
      file: "/agent/instructions.md",
      read: importReader(new Map()),
    })).rejects.toThrow("cannot use globs")
  })
})
