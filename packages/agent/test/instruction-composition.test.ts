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

  it("allows sibling imports to reuse the same file", async () => {
    const files = new Map([["/agent/shared.md", "Shared"]])

    expect(await resolveInstructionImports([
      "@./shared.md",
      "",
      "@./shared.md",
    ].join("\n"), {
      file: "/agent/instructions.md",
      read: importReader(files),
    })).toBe("Shared\n\nShared")
  })

  it("normalizes shorthand conditions from imported documents", async () => {
    const files = new Map([["/agent/policy.md", "::if{context.enabled}\nEnabled\n::"]])
    const imported = await resolveInstructionImports("@./policy.md", {
      file: "/agent/instructions.md",
      read: importReader(files),
    })

    expect(await composeInstructionDocument(imported, { context: { enabled: true } })).toBe("Enabled")
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

  it("preserves trusted markdown bindings after punctuation", async () => {
    expect(await composeInstructionDocument("Use ({{{ context.policy }}}).", {
      context: { policy: "trusted policy" },
    })).toBe("Use (trusted policy).")
  })

  it("preserves XML-style prompt tags as authored text", async () => {
    expect(await composeInstructionDocument("<policy>Use {{ context.name }}.</policy>", {
      context: { name: "Acme" },
    })).toBe("<policy>Use Acme.</policy>")
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

  it("renders workspace scalar bindings", async () => {
    expect(await composeInstructionDocument([
      "Use {{ workspace.tone }} tone.",
      "Priority {{ workspace.priority }}.",
    ].join("\n"), {
      workspace: {
        priority: 2,
        tone: "short",
      },
    })).toBe("Use short tone.\nPriority 2.")
  })

  it("throws when instruction bindings are missing", async () => {
    await expect(composeInstructionDocument("Hello {{ context.doesNotExist }}."))
      .rejects.toThrow("Instruction binding \"{{ context.doesNotExist }}\" is not defined")
    await expect(composeInstructionDocument("{{ context.customerName }}", { context: { customerName: null } }))
      .rejects.toThrow("Instruction binding \"{{ context.customerName }}\" is not defined")
    await expect(composeInstructionDocument("{{ workspace.tone }}"))
      .rejects.toThrow("Instruction binding \"{{ workspace.tone }}\" is not defined")
    await expect(composeInstructionDocument("{{ workspace.tone }}", { workspace: { tone: null } }))
      .rejects.toThrow("Instruction binding \"{{ workspace.tone }}\" is not defined")
    await expect(composeInstructionDocument("{{{ context.policy }}}"))
      .rejects.toThrow("Instruction markdown binding \"{{{ context.policy }}}\" is not defined")
    await expect(composeInstructionDocument("{{{ context.policy }}}", { context: { policy: null } }))
      .rejects.toThrow("Instruction markdown binding \"{{{ context.policy }}}\" is not defined")
  })

  it("imports workspace markdown bindings through composition", async () => {
    expect(await composeInstructionDocument([
      "# Support",
      "@workspace.policy",
    ].join("\n"), {
      context: {
        customerName: "Acme",
        technical: true,
      },
      workspace: {
        policy: [
          "## Policy",
          "::if{context.technical}",
          "Use technical detail for {{ context.customerName }}.",
          "::else",
          "Use support detail.",
          "::",
        ].join("\n"),
      },
    })).toBe([
      "# Support",
      "## Policy",
      "Use technical detail for Acme.",
    ].join("\n\n"))
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
    await expect(composeInstructionDocument("::if{context.enabled}\nEnabled\n::else{condition=\"context.admin\"}\nFallback\n::"))
      .rejects.toThrow("else block does not accept a condition")
    await expect(composeInstructionDocument("::if{context.enabled}\nEnabled"))
      .rejects.toThrow("missing a closing")
    await expect(composeInstructionDocument("::if{context.enabled}\nEnabled\n::else\nFallback\n::else-if{context.admin}\nAdmin\n::"))
      .rejects.toThrow("else-if block cannot follow else")
    await expect(resolveInstructionImports("@https://example.com/policy.md", {
      file: "/agent/instructions.md",
      read: importReader(new Map()),
    })).rejects.toThrow("must be a relative file path")
    await expect(resolveInstructionImports("@./*.md", {
      file: "/agent/instructions.md",
      read: importReader(new Map()),
    })).rejects.toThrow("cannot use globs")
    await expect(composeInstructionDocument("@workspace.policy"))
      .rejects.toThrow("workspace import \"@workspace.policy\" is not defined")
  })
})
