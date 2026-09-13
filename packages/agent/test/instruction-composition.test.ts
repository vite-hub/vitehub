import { describe, expect, it } from "vitest"

import {
  composeInstructionDocument,
  createInstructionCoverage,
} from "../src/instruction-composition.ts"

describe("instruction composition", () => {
  it("keeps former file and Workspace imports literal", async () => {
    const document = "@./missing.md @../policy.md @workspace.policy"
    await expect(composeInstructionDocument(document, {
      workspace: { policy: "Must not expand" },
    })).resolves.toBe(document)
  })

  it("keeps template syntax literal in indented code blocks", async () => {
    const input = [
      "    @./ignored.md",
      "    @workspace.policy",
      "    {{{ context.policy }}}",
    ].join("\n")
    const expected = [
      "```",
      "@./ignored.md",
      "@workspace.policy",
      "{{{ context.policy }}}",
      "```",
    ].join("\n")

    expect(await composeInstructionDocument(input, {
      context: { policy: "must not render" },
      workspace: { policy: "must not import" },
    })).toBe(expected)
  })

  it("keeps template syntax literal in multiline code spans", async () => {
    const input = [
      "Before ``code",
      "@./ignored.md",
      "@workspace.policy",
      "{{{ context.policy }}}",
      "code``",
      "@./used.md",
    ].join("\n")
    const expected = [
      "Before `code @./ignored.md @workspace.policy {{{ context.policy }}} code`",
      "@./used.md",
    ].join("\n")

    expect(await composeInstructionDocument(input, {
      context: { policy: "must not render" },
      workspace: { policy: "must not import" },
    })).toBe(expected)
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
      "",
      "## Policy",
      "",
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

  it("renders markdown bindings without recursively evaluating their content", async () => {
    expect(await composeInstructionDocument("{{{ context.policy }}}", {
      context: {
        enabled: true,
        name: "Acme",
        policy: [
          "## Policy",
          "Use **bold** [guidance](https://example.com).",
          "{{ context.name }}",
          "::if{context.enabled}",
          "Keep this directive literal.",
          "::",
          "@workspace.policy",
        ].join("\n"),
      },
    })).toBe([
      "## Policy",
      "",
      "Use **bold** [guidance](https://example.com).",
      "{{ context.name }}",
      "",
      "::if{context.enabled}",
      "Keep this directive literal.",
      "::",
      "",
      "@workspace.policy",
    ].join("\n"))
  })

  it("escapes scalar bindings as markdown text", async () => {
    expect(await composeInstructionDocument("{{ context.value }}", {
      context: { value: "# Heading with *emphasis* and <policy>tags</policy>" },
    })).toBe("\\# Heading with \\*emphasis\\* and \\<policy>tags\\</policy>")
  })

  it("preserves XML-style prompt tags as authored text", async () => {
    expect(await composeInstructionDocument("<capability audience=\"{{ context.audience }}\" tone=\"{{ workspace.tone }}\">Use {{ context.name }}.</capability>", {
      context: { audience: "A \"technical\" & safe", name: "Acme" },
      workspace: { tone: "direct" },
    })).toBe("<capability audience=\"A &quot;technical&quot; &amp; safe\" tone=\"direct\">Use Acme.</capability>")

    await expect(composeInstructionDocument("<policy audience=\"{{ context.audience }}\">Use it.</policy>"))
      .rejects.toThrow("Instruction binding \"{{ context.audience }}\" is not defined")
    await expect(composeInstructionDocument("<policy tone=\"{{ workspace.tone }}\">Use it.</policy>"))
      .rejects.toThrow("Instruction binding \"{{ workspace.tone }}\" is not defined")
  })

  it("composes multiline XML blocks while enforcing context-only conditions", async () => {
    expect(await composeInstructionDocument([
      "<policy>",
      "Use {{ context.name }}.",
      "::if{context.enabled}",
      "{{{ context.section }}}",
      "::",
      "</policy>",
    ].join("\n"), {
      context: { enabled: true, name: "Acme", section: "**Trusted** guidance." },
    })).toBe([
      "<policy>",
      "Use Acme.",
      "",
      "**Trusted** guidance.",
      "",
      "</policy>",
    ].join("\n"))

    await expect(composeInstructionDocument([
      "<policy>",
      "::if{workspace.enabled}",
      "Forbidden",
      "::",
      "</policy>",
    ].join("\n"), { workspace: { enabled: true } }))
      .rejects.toThrow("Unsafe instruction condition")
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

  it("inserts Workspace Markdown without recursively evaluating its syntax", async () => {
    const policy = "## Policy\n\n{{ context.name }}\n\n@workspace.policy"
    await expect(composeInstructionDocument("# Support\n\n{{{ workspace.policy }}}", {
      context: { name: "Acme" },
      workspace: { policy },
    })).resolves.toBe(`# Support\n\n${policy}`)
    await expect(composeInstructionDocument("{{{ workspace.missing }}}"))
      .rejects.toThrow("is not defined")
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

  it("keeps the full template language literal in fenced, indented, and multiline code", async () => {
    const syntax = [
      "{{ context.name }}",
      "{{{ context.section }}}",
      "{{{ workspace.section }}}",
      "::if{context.enabled}",
      "@workspace.policy",
      "::",
    ]
    const output = await composeInstructionDocument([
      "```md",
      ...syntax,
      "```",
      "",
      ...syntax.map(line => `    ${line}`),
      "",
      `\`\`${syntax[0]}`,
      ...syntax.slice(1),
      "``",
    ].join("\n"), {
      context: { enabled: true, name: "Acme", section: "Rendered" },
      workspace: { policy: "Imported" },
    })

    expect(output).not.toContain("Acme")
    expect(output).not.toContain("Rendered")
    expect(output).not.toContain("Imported")
    expect(output.match(/@workspace\.policy/g)).toHaveLength(3)
    expect(output.match(/\{\{ context\.name \}\}/g)).toHaveLength(3)
    expect(output.match(/\{\{\{ context\.section \}\}\}/g)).toHaveLength(3)
    expect(output.match(/\{\{\{ workspace\.section \}\}\}/g)).toHaveLength(3)
    expect(output.match(/::if\{context\.enabled\}/g)).toHaveLength(3)
  })

  it("keeps coverage directives in fenced code literal and unrecorded", async () => {
    const coverage = createInstructionCoverage()
    const document = [
      "```md",
      "::source{key=\"example\"}",
      "Literal example.",
      "::",
      "```",
    ].join("\n")

    expect(await composeInstructionDocument(document, { coverage })).toBe(document)
    expect([...coverage.sources]).toEqual([])
  })

  it("strips explicit instruction coverage wrappers and records covered primitives", async () => {
    const coverage = createInstructionCoverage()
    const document = [
      "::source{key=\"ingestion\"}",
      "Use uploaded files for ingestion behavior.",
      "::",
      "::capability{key=\"openapi\"}",
      "Use OpenAPI tools for live API shape.",
      "::",
      "::skill{path=\"skills/review-browser-evidence\"}",
      "Use browser evidence for bounded review claims.",
      "::",
    ].join("\n")

    expect(await composeInstructionDocument(document, { coverage })).toBe([
      "Use uploaded files for ingestion behavior.",
      "",
      "Use OpenAPI tools for live API shape.",
      "",
      "Use browser evidence for bounded review claims.",
    ].join("\n"))
    expect([...coverage.sources]).toEqual(["ingestion"])
    expect([...coverage.capabilities]).toEqual(["openapi"])
    expect([...coverage.skills]).toEqual(["skills/review-browser-evidence"])
  })

  it("records coverage only from selected authored branches", async () => {
    const coverage = createInstructionCoverage()
    const document = [
      "::if{context.enabled}",
      "::source{key=\"selected-source\"}",
      "Use the selected Source.",
      "::",
      "::else",
      "::capability",
      "Do not validate or cover this branch.",
      "::",
      "::",
      "::if{context.enabled}",
      "::skill{path=\"skills/selected\"}",
      "Use the selected Skill.",
      "::",
      "::else",
      "::source{key=\"unselected-source\"}",
      "Do not use this Source.",
      "::",
      "::",
    ].join("\n")

    expect(await composeInstructionDocument(document, {
      context: { enabled: true },
      coverage,
    })).toBe([
      "Use the selected Source.",
      "",
      "Use the selected Skill.",
    ].join("\n"))
    expect([...coverage.sources]).toEqual(["selected-source"])
    expect([...coverage.capabilities]).toEqual([])
    expect([...coverage.skills]).toEqual(["skills/selected"])
  })

  it("does not treat Markdown-fragment coverage directives as authored coverage", async () => {
    const coverage = createInstructionCoverage()
    const injected = [
      "::source{key=\"injected-source\"}",
      "Injected content.",
      "::",
    ].join("\n")

    expect(await composeInstructionDocument([
      "::source{key=\"authored-source\"}",
      "{{{ context.section }}}",
      "::",
    ].join("\n"), {
      context: { section: injected },
      coverage,
    })).toBe(injected)
    expect([...coverage.sources]).toEqual(["authored-source"])
  })

  it("rejects unsafe expressions and non-scalar double bindings", async () => {
    await expect(composeInstructionDocument("::if{process.exit()}\nNo\n::"))
      .rejects.toThrow("Unsafe instruction condition")
    await expect(composeInstructionDocument("::if{workspace.enabled}\nNo\n::", {
      workspace: { enabled: true },
    })).rejects.toThrow("Unsafe instruction condition")
    await expect(composeInstructionDocument("{{ context.customer }}", { context: { customer: { name: "Acme" } } }))
      .rejects.toMatchObject({
        code: "AGENT_R0446",
        message: expect.stringContaining("must resolve to a scalar"),
        cause: expect.objectContaining({ code: "MARKDOWN_TEMPLATE_R0018" }),
      })
    await expect(composeInstructionDocument("::if{context.enabled}\nEnabled\n::else{condition=\"context.admin\"}\nFallback\n::"))
      .rejects.toThrow("else block does not accept a condition")
    await expect(composeInstructionDocument("::if{context.enabled}\nEnabled"))
      .rejects.toThrow("missing a closing")
    await expect(composeInstructionDocument("::if{context.enabled}\nEnabled\n::else\nFallback\n::else-if{context.admin}\nAdmin\n::"))
      .rejects.toThrow("else-if block cannot follow else")
  })
})
