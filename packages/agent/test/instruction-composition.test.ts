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
      "    :insert{:markdown=\"data.context.policy\"}",
    ].join("\n")
    const expected = [
      "```",
      "@./ignored.md",
      "@workspace.policy",
      ":insert{:markdown=\"data.context.policy\"}",
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
      ":insert{:markdown=\"data.context.policy\"}",
      "code``",
      "@./used.md",
    ].join("\n")
    const expected = [
      "Before `code @./ignored.md @workspace.policy :insert{:markdown=\"data.context.policy\"} code`",
      "@./used.md",
    ].join("\n")

    expect(await composeInstructionDocument(input, {
      context: { policy: "must not render" },
      workspace: { policy: "must not import" },
    })).toBe(expected)
  })

  it("renders condition chains and context bindings without executing JavaScript", async () => {
    const document = [
      "Hello {{ data.context.customerName }}.",
      "::insert{:markdown=\"data.context.supportPolicy\"}\n::",
      "::if{:condition=\"data.context.technicalAudience\"}",
      "Use technical detail.",
      "::else-if{:value=\"data.context.audience\" eq=\"support\"}",
      "Use support detail.",
      "::else",
      "Use fallback detail.",
      "::\n::\n::",
    ].join("\n")

    expect(await composeInstructionDocument(document, {
      context: {
        audience: "technical",
        technicalAudience: true,
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
    expect(await composeInstructionDocument("Use (<Insert :markdown=\"data.context.policy\"></Insert>).", {
      context: { policy: "trusted policy" },
    })).toBe("Use (trusted policy).")
  })

  it("renders markdown bindings without recursively evaluating their content", async () => {
    expect(await composeInstructionDocument(":insert{:markdown=\"data.context.policy\"}", {
      context: {
        enabled: true,
        name: "Acme",
        policy: [
          "## Policy",
          "Use **bold** [guidance](https://example.com).",
          "{{ data.context.name }}",
          "::if{:condition=\"data.context.enabled\"}",
          "Keep this directive literal.",
          "::",
          "@workspace.policy",
        ].join("\n"),
      },
    })).toBe([
      "## Policy",
      "",
      "Use **bold** [guidance](https://example.com).",
      "{{ data.context.name }}",
      "",
      "::if{:condition=\"data.context.enabled\"}",
      "Keep this directive literal.",
      "::",
      "",
      "@workspace.policy",
    ].join("\n"))
  })

  it("escapes scalar bindings as markdown text", async () => {
    expect(await composeInstructionDocument("{{ data.context.value }}", {
      context: { value: "# Heading with *emphasis* and <policy>tags</policy>" },
    })).toBe("\\# Heading with \\*emphasis\\* and \\<policy>tags\\</policy>")
  })

  it("preserves XML-style prompt tags as authored text", async () => {
    expect(await composeInstructionDocument("<capability :audience=\"data.context.audience\" :tone=\"data.workspace.tone\">Use {{ data.context.name }}.</capability>", {
      context: { audience: "A \"technical\" & safe", name: "Acme" },
      workspace: { tone: "direct" },
    })).toBe("<capability audience=\"A &quot;technical&quot; &amp; safe\" tone=\"direct\">Use Acme.</capability>")

    await expect(composeInstructionDocument("<policy :audience=\"data.context.audience\">Use it.</policy>"))
      .rejects.toThrow("Instruction binding \"data.context.audience\" is not defined")
    await expect(composeInstructionDocument("<policy :tone=\"data.workspace.tone\">Use it.</policy>"))
      .rejects.toThrow("Instruction binding \"data.workspace.tone\" is not defined")
  })

  it("composes multiline XML blocks while enforcing context-only conditions", async () => {
    expect(await composeInstructionDocument([
      "<policy>",
      "Use {{ data.context.name }}.",
      "::if{:condition=\"data.context.enabled\"}",
      ":insert{:markdown=\"data.context.section\"}",
      "::",
      "</policy>",
    ].join("\n"), {
      context: { enabled: true, name: "Acme", section: "**Trusted** guidance." },
    })).toBe([
      "<policy>",
      "Use Acme.",
      "",
      "",
      "**Trusted** guidance.",
      "</policy>",
    ].join("\n"))

    await expect(composeInstructionDocument([
      "<policy>",
      "::if{:condition=\"data.workspace.enabled\"}",
      "Forbidden",
      "::",
      "</policy>",
    ].join("\n"), { workspace: { enabled: true } }))
      .rejects.toThrow("Unsafe instruction condition")
  })

  it("combines a context condition with comparison props", async () => {
    expect(await composeInstructionDocument([
      "::if{:condition=\"data.context.enabled\" :value=\"data.context.customerName\" neq=\"\"}",
      "Enabled.",
      "::else",
      "Disabled.",
      "::\n::",
    ].join("\n"), { context: { customerName: "Acme", enabled: false } })).toBe("Disabled.")

    expect(await composeInstructionDocument([
      "::if{:value=\"data.context.enabled\" :eq=\"true\"}",
      "Enabled.",
      "::else",
      "Disabled.",
      "::\n::",
    ].join("\n"), { context: { customerName: "Acme", enabled: true } })).toBe("Enabled.")
  })

  it("reads nested context paths and keys with hyphens", async () => {
    expect(await composeInstructionDocument([
      "{{ data.context.llm-route.choice }}",
      "{{ data.context.support.customer.name }}",
    ].join("\n"), {
      context: {
        "llm-route": { choice: "fast" },
        support: { customer: { name: "Acme" } },
      },
    })).toBe("fast\nAcme")
  })

  it("renders workspace scalar bindings", async () => {
    expect(await composeInstructionDocument([
      "Use {{ data.workspace.tone }} tone.",
      "Priority {{ data.workspace.priority }}.",
    ].join("\n"), {
      workspace: {
        priority: 2,
        tone: "short",
      },
    })).toBe("Use short tone.\nPriority 2.")
  })

  it("throws when instruction bindings are missing", async () => {
    await expect(composeInstructionDocument("Hello {{ data.context.doesNotExist }}."))
      .rejects.toThrow("Instruction binding \"data.context.doesNotExist\" is not defined")
    await expect(composeInstructionDocument("{{ data.context.customerName }}", { context: { customerName: null } }))
      .rejects.toThrow("Instruction binding \"data.context.customerName\" is not defined")
    await expect(composeInstructionDocument("{{ data.workspace.tone }}"))
      .rejects.toThrow("Instruction binding \"data.workspace.tone\" is not defined")
    await expect(composeInstructionDocument("{{ data.workspace.tone }}", { workspace: { tone: null } }))
      .rejects.toThrow("Instruction binding \"data.workspace.tone\" is not defined")
    await expect(composeInstructionDocument(":insert{:markdown=\"data.context.policy\"}"))
      .rejects.toThrow("Instruction binding \"data.context.policy\" is not defined")
    await expect(composeInstructionDocument(":insert{:markdown=\"data.context.policy\"}", { context: { policy: null } }))
      .rejects.toThrow("Instruction binding \"data.context.policy\" is not defined")
  })

  it("inserts Workspace Markdown without recursively evaluating its syntax", async () => {
    const policy = "## Policy\n\n{{ data.context.name }}\n\n@workspace.policy"
    await expect(composeInstructionDocument("# Support\n\n:insert{:markdown=\"data.workspace.policy\"}", {
      context: { name: "Acme" },
      workspace: { policy },
    })).resolves.toBe(`# Support\n\n${policy}`)
    await expect(composeInstructionDocument(":insert{:markdown=\"data.workspace.missing\"}"))
      .rejects.toThrow("is not defined")
  })

  it("does not render bindings or directives inside code spans and fences", async () => {
    expect(await composeInstructionDocument([
      "Hello {{ data.context.name }}.",
      "`{{ data.context.name }}`",
      "`::if{:condition=\"data.context.enabled\"}`",
      "```md",
      "{{ data.context.name }}",
      "::if{:condition=\"data.context.enabled\"}",
      "Hidden",
      "::",
      "```",
    ].join("\n"), {
      context: { enabled: false, name: "Acme" },
    })).toBe([
      "Hello Acme.",
      "`{{ data.context.name }}`",
      "`::if{:condition=\"data.context.enabled\"}`",
      "",
      "```md",
      "{{ data.context.name }}",
      "::if{:condition=\"data.context.enabled\"}",
      "Hidden",
      "::",
      "```",
    ].join("\n"))
  })

  it("keeps the full template language literal in fenced, indented, and multiline code", async () => {
    const syntax = [
      "{{ data.context.name }}",
      ":insert{:markdown=\"data.context.section\"}",
      ":insert{:markdown=\"data.workspace.section\"}",
      "::if{:condition=\"data.context.enabled\"}",
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
    for (const literal of syntax.filter(line => line !== "::")) expect(output.split(literal)).toHaveLength(4)
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
      "::if{:condition=\"data.context.enabled\"}",
      "::source{key=\"selected-source\"}",
      "Use the selected Source.",
      "::",
      "::else",
      "::capability",
      "Do not validate or cover this branch.",
      "::",
      "::",
      "::",
      "::if{:condition=\"data.context.enabled\"}",
      "::skill{path=\"skills/selected\"}",
      "Use the selected Skill.",
      "::",
      "::else",
      "::source{key=\"unselected-source\"}",
      "Do not use this Source.",
      "::",
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
      ":insert{:markdown=\"data.context.section\"}",
      "::",
    ].join("\n"), {
      context: { section: injected },
      coverage,
    })).toBe(injected)
    expect([...coverage.sources]).toEqual(["authored-source"])
  })

  it.each([true, false])("keeps enclosing coverage intact across native branches with enabled=%s", async (enabled) => {
    const coverage = createInstructionCoverage()
    const template = `::source{key="docs"}
::if{:condition="data.context.enabled"}
Read detailed docs.
::else
Read the overview.
::
::
Always cite docs.
::`
    const output = await composeInstructionDocument(template, { context: { enabled }, coverage })
    expect(output).toContain(enabled ? "Read detailed docs." : "Read the overview.")
    expect(output).toContain("Always cite docs.")
    expect(output).not.toContain("::")
    expect(output).not.toContain("vitehub-instruction-coverage")
    expect([...coverage.sources]).toEqual(["docs"])
  })

  it("rejects unsafe expressions and non-scalar double bindings", async () => {
    await expect(composeInstructionDocument("::if{:condition=\"process.exit()\"}\nNo\n::"))
      .rejects.toThrow("Unsafe instruction condition")
    await expect(composeInstructionDocument("::if{:condition=\"data.workspace.enabled\"}\nNo\n::", {
      workspace: { enabled: true },
    })).rejects.toThrow("Unsafe instruction condition")
    await expect(composeInstructionDocument("{{ data.context.customer }}", { context: { customer: { name: "Acme" } } }))
      .rejects.toMatchObject({
        code: "AGENT_R0446",
        message: expect.stringContaining("must resolve to a scalar"),
        cause: expect.objectContaining({ code: "MARKDOWN_TEMPLATE_R0018" }),
      })
    await expect(composeInstructionDocument("::if{:condition=\"data.context.enabled\"}\nEnabled\n::else{condition=\"context.admin\"}\nFallback\n::\n::"))
      .rejects.toThrow("else block does not accept a condition")
    await expect(composeInstructionDocument("::if{:condition=\"data.context.enabled\"}\nEnabled"))
      .rejects.toThrow("missing a closing")
    await expect(composeInstructionDocument("::if{:condition=\"data.context.enabled\"}\nEnabled\n::else\nFallback\n::else-if{:condition=\"data.context.admin\"}\nAdmin\n::\n::\n::"))
      .rejects.toThrow("else-if block cannot follow else")
  })
})
