import { describe, expect, it, vi } from "vitest"

import {
  renderMarkdownTemplateInternal,
  resolveMarkdownTemplateImports,
} from "../src/internal/composition.ts"
import { renderMarkdownTemplate } from "../src/index.ts"

describe("renderMarkdownTemplate", () => {
  it("renders scalar data as Markdown text", async () => {
    expect(await renderMarkdownTemplate([
      "Hello {{ pullRequest.title }}.",
      "Attempt {{ count }} is {{ active }}.",
      "{{ routes.llm-route.choice }}",
      "{{ support.customer.name }}",
    ].join("\n"), {
      data: {
        active: true,
        count: 2,
        pullRequest: { title: "*untrusted* <policy>text</policy>" },
        routes: { "llm-route": { choice: "fast" } },
        "support.customer": { name: "Acme" },
      },
    })).toBe([
      "Hello \\*untrusted\\* \\<policy>text\\</policy>.",
      "Attempt 2 is true.",
      "fast",
      "Acme",
    ].join("\n"))
  })

  it("renders scalar bindings as complete Markdown link destinations", async () => {
    await expect(renderMarkdownTemplate("[Open recap]({{ url }})", {
      data: { url: "https://prs.onmax.me/recap/2026-07" },
    })).resolves.toBe("[Open recap](https://prs.onmax.me/recap/2026-07)")

    await expect(renderMarkdownTemplate("[Open recap]({{ url }})", {
      data: { url: "/recap/July 2026_(final)?share=team&from=email#top" },
    })).resolves.toBe("[Open recap](/recap/July%202026_%28final%29?share=team&from=email#top)")

    await expect(renderMarkdownTemplate("[Open recap]({{ url }})", {
      data: { url: "https://example.com/recap/July%202026?signature=a%2Fb%3D" },
    })).resolves.toBe("[Open recap](https://example.com/recap/July%202026?signature=a%2Fb%3D)")

    await expect(renderMarkdownTemplate("[Open recap]({{ url }})", {
      data: { url: "https://example.com/a) [Injected](https://evil.test?q=\"x\"" },
    })).resolves.toBe("[Open recap](https://example.com/a%29%20%5BInjected%5D%28https://evil.test?q=%22x%22)")

    await expect(renderMarkdownTemplate("[Open recap]({{ url }})", {
      data: { url: "https://example.com/?x=&#x29;*Injected*" },
    })).resolves.toBe("[Open recap](https://example.com/?x=%26#x29;*Injected*)")

    await expect(renderMarkdownTemplate("[Open recap]({{ url }})", {
      data: { url: "http://[::1]/recap" },
    })).resolves.toBe("[Open recap](http://[::1]/recap)")

    await expect(renderMarkdownTemplate("[Open recap]({{ url }} \"Monthly recap\")", {
      data: { url: "https://prs.onmax.me/recap/2026-07" },
    })).resolves.toBe("[Open recap](https://prs.onmax.me/recap/2026-07){title=\"Monthly recap\"}")
  })

  it("rejects unsafe Markdown link destinations", async () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "https://example.com/first\n[Injected](https://evil.test)",
      "https://example.com/\uD800",
    ]) {
      await expect(renderMarkdownTemplate("[Open recap]({{ url }})", { data: { url } }))
        .rejects.toThrow("must resolve to a safe destination")
    }

    await expect(renderMarkdownTemplate("[Open recap]({{ url }})"))
      .rejects.toThrow("binding \"{{ url }}\" is not defined")
    await expect(renderMarkdownTemplate("[Open recap]({{ url }})", { data: { url: {} } }))
      .rejects.toThrow("must resolve to a scalar value")

    await expect(renderMarkdownTemplate([
      "::if{enabled}",
      "[Open recap]({{ missing }})",
      "::else",
      "No recap",
      "::",
    ].join("\n"), { data: { enabled: false } })).resolves.toBe("No recap")
  })

  it("renders Markdown fragments without recursively evaluating template syntax", async () => {
    const template = [
      "# Review",
      "{{{ sections.body }}}",
      "",
      "Use ({{{ sections.inline }}}).",
    ].join("\n")

    expect(await renderMarkdownTemplate(template, {
      data: {
        pullRequest: { available: true, repository: "vite-hub/vitehub" },
        sections: {
          body: [
            "## Body",
            "Use **bold** [guidance](https://example.com).",
            "{{ pullRequest.repository }}",
            "::if{pullRequest.available}",
            "Keep this branch literal.",
            "::",
            "@./literal.md",
          ].join("\n"),
          inline: "**raw Markdown**",
        },
      },
      resolveImport: async () => {
        throw new Error("fragment imports must not resolve")
      },
    })).toBe([
      "# Review",
      "",
      "## Body",
      "",
      "Use **bold** [guidance](https://example.com).",
      "{{ pullRequest.repository }}",
      "",
      "::if{pullRequest.available}",
      "Keep this branch literal.",
      "::",
      "",
      "@./literal.md",
      "",
      "Use (**raw Markdown**).",
    ].join("\n"))
  })

  it("rejects block Markdown in an inline fragment slot", async () => {
    await expect(renderMarkdownTemplate("Use ({{{ section }}}).", {
      data: { section: "## Block heading" },
    })).rejects.toThrow("cannot contain block Markdown when used inline")
    await expect(renderMarkdownTemplate("**Prefix** {{{ section }}}", {
      data: { section: "## Block heading" },
    })).rejects.toThrow("cannot contain block Markdown when used inline")
    await expect(renderMarkdownTemplate("{{{ section }}} [suffix](https://example.com)", {
      data: { section: "## Block heading" },
    })).rejects.toThrow("cannot contain block Markdown when used inline")
  })

  it("separates consecutive standalone fragments selected by branches", async () => {
    expect(await renderMarkdownTemplate([
      "::if{sections.title}",
      "{{{ sections.title }}}",
      "::",
      "::if{sections.body}",
      "{{{ sections.body }}}",
      "::",
    ].join("\n"), {
      data: {
        sections: {
          body: "## Body\nBody",
          title: "## Title\nTitle",
        },
      },
    })).toBe([
      "## Title",
      "",
      "Title",
      "",
      "## Body",
      "",
      "Body",
    ].join("\n"))
  })

  it("selects bounded if, else-if, and else branches", async () => {
    const template = [
      "::if{pullRequest.available && pullRequest.draft}",
      "Draft",
      "::else-if{pullRequest.available && (pullRequest.kind === 'review' || pullRequest.kind === 'issue')}",
      "Review",
      "::else",
      "Missing",
      "::",
    ].join("\n")

    await expect(renderMarkdownTemplate(template, {
      data: { pullRequest: { available: true, draft: false, kind: "review" } },
    })).resolves.toBe("Review")
  })

  it("consumes both sides of boolean expressions", async () => {
    const andTemplate = "::if{enabled && name}\nEnabled\n::else\nDisabled\n::"
    const orTemplate = "::if{enabled || name}\nEnabled\n::else\nDisabled\n::"

    await expect(renderMarkdownTemplate(andTemplate, {
      data: { enabled: false, name: "Acme" },
    })).resolves.toBe("Disabled")
    await expect(renderMarkdownTemplate(orTemplate, {
      data: { enabled: true, name: "Acme" },
    })).resolves.toBe("Enabled")
  })

  it("preserves authored XML-style tags", async () => {
    expect(await renderMarkdownTemplate("<policy>Use {{ customer.name }}.</policy>", {
      data: { customer: { name: "Acme" } },
    })).toBe("<policy>Use Acme.</policy>")
  })

  it("renders scalar bindings in quoted XML attributes", async () => {
    expect(await renderMarkdownTemplate("<policy audience=\"{{ audience }}\" tone='{{ tone }}'>Use it.</policy>", {
      data: {
        audience: "A \"technical\" & safe audience",
        tone: "reviewer's <direct> tone",
      },
    })).toBe("<policy audience=\"A &quot;technical&quot; &amp; safe audience\" tone='reviewer&#39;s &lt;direct&gt; tone'>Use it.</policy>")

    await expect(renderMarkdownTemplate("<policy audience=\"{{ audience }}\">Use it.</policy>"))
      .rejects.toThrow("binding \"{{ audience }}\" is not defined")
  })

  it("only renders tag attribute bindings in the selected branch", async () => {
    await expect(renderMarkdownTemplate([
      "::if{enabled}",
      "<policy audience=\"{{ missing }}\">Hidden</policy>",
      "::else",
      "Visible",
      "::",
    ].join("\n"), {
      data: { enabled: false },
    })).resolves.toBe("Visible")
  })

  it("composes the full template language inside multiline XML blocks", async () => {
    expect(await renderMarkdownTemplate([
      "<policy>",
      "Use {{ customer.name }}.",
      "::if{enabled}",
      "{{{ section }}}",
      "@./detail.md",
      "::",
      "</policy>",
    ].join("\n"), {
      data: {
        customer: { name: "Acme" },
        enabled: true,
        section: "**Trusted** guidance.",
      },
      resolveImport: async () => ({ id: "/detail.md", template: "Imported detail." }),
      sourceId: "/instructions.md",
    })).toBe([
      "<policy>",
      "Use Acme.",
      "",
      "**Trusted** guidance.",
      "",
      "Imported detail.",
      "",
      "</policy>",
    ].join("\n"))
  })

  it("keeps bindings, fragments, branches, and imports literal in code", async () => {
    const resolveImport = vi.fn(() => ({ id: "/used.md", template: "Used" }))
    const template = [
      "`{{ name }}`",
      "``{{{ section }}}``",
      "```md",
      "{{ name }}",
      "{{{ section }}}",
      "::if{enabled}",
      "@./ignored.md",
      "::",
      "<policy audience=\"{{ name }}\">literal</policy>",
      "```",
      "",
      "    {{ name }}",
      "    {{{ section }}}",
      "    ::if{enabled}",
      "    @./ignored.md",
      "    ::",
      "",
      "``{{ name }}",
      "{{{ section }}}",
      "::if{enabled}",
      "@./ignored.md",
      "::",
      "``",
      "",
      "@./used.md",
    ].join("\n")

    expect(await renderMarkdownTemplate(template, {
      data: { enabled: true, name: "Acme", section: "Rendered" },
      resolveImport,
      sourceId: "/instructions.md",
    })).toBe([
      "`{{ name }}`",
      "`{{{ section }}}`",
      "",
      "```md",
      "{{ name }}",
      "{{{ section }}}",
      "::if{enabled}",
      "@./ignored.md",
      "::",
      "<policy audience=\"{{ name }}\">literal</policy>",
      "```",
      "",
      "```",
      "{{ name }}",
      "{{{ section }}}",
      "::if{enabled}",
      "@./ignored.md",
      "::",
      "```",
      "",
      "`{{ name }} {{{ section }}} ::if{enabled} @./ignored.md :: `",
      "",
      "Used",
    ].join("\n"))
    expect(resolveImport).toHaveBeenCalledOnce()
    expect(resolveImport).toHaveBeenCalledWith("./used.md", "/instructions.md")
  })

  it("preserves blank lines inside fenced code", async () => {
    await expect(renderMarkdownTemplate("```md\nfirst\n\n\nlast\n```"))
      .resolves.toBe("```md\nfirst\n\n\nlast\n```")
  })

  it("does not expose internal placeholders or render handlers", async () => {
    const authored = [
      ":markdown-template-raw{value=\"Injected\"}",
      "%%VITEHUB_MARKDOWN_TEMPLATE_FRAGMENT_0%%",
      "{{{ section }}}",
    ].join("\n")
    const rendered = await renderMarkdownTemplate(authored, { data: { section: "Rendered" } })

    expect(rendered).toContain("markdown-template-raw")
    expect(rendered).toContain("%%VITEHUB_MARKDOWN_TEMPLATE_FRAGMENT_0%%")
    expect(rendered).toContain("Rendered")
    expect(rendered).not.toBe("Injected")
  })

  it("resolves nested relative imports by canonical id", async () => {
    const files = new Map([
      ["/nested.md", "## Nested\n@./policy.md"],
      ["/policy.md", "::if{enabled}\nPolicy for {{ customer.name }}\n::"],
    ])
    const resolveImport = vi.fn(async (specifier: string, importer: string) => {
      const id = new URL(specifier, `file://${importer}`).pathname
      const imported = files.get(id)
      return imported === undefined ? undefined : { id, template: imported }
    })

    expect(await renderMarkdownTemplate("# Base\n@./nested.md", {
      data: { customer: { name: "Acme" }, enabled: true },
      resolveImport,
      sourceId: "/instructions.md",
    })).toBe([
      "# Base",
      "",
      "## Nested",
      "",
      "Policy for Acme",
    ].join("\n"))
    expect(resolveImport).toHaveBeenNthCalledWith(1, "./nested.md", "/instructions.md")
    expect(resolveImport).toHaveBeenNthCalledWith(2, "./policy.md", "/nested.md")
  })

  it("resolves imports without evaluating the template", async () => {
    await expect(resolveMarkdownTemplateImports([
      "Hello {{ name }}.",
      "@workspace.policy",
      "@mention",
    ].join("\n"), {
      resolveBareImport: async specifier => specifier === "workspace.policy"
        ? { id: specifier, template: "::if{enabled}\nPolicy\n::" }
        : undefined,
    })).resolves.toBe([
      "Hello {{ name }}.",
      "::if{condition=\"enabled\"}",
      "Policy",
      "::",
      "@mention",
    ].join("\n"))

    await expect(resolveMarkdownTemplateImports("@./policy.md", {
      resolveImport: async () => ({ id: "/policy.md", template: "::if{enabled}\nPolicy" }),
    })).rejects.toThrow("missing a closing")
  })

  it("leaves relative-looking text literal when no resolver is provided", async () => {
    await expect(renderMarkdownTemplate("Read @./policy.md")).resolves.toBe("Read @./policy.md")
  })

  it("rejects invalid imports, cycles, and depth overflow", async () => {
    const resolveImport = async (specifier: string) => ({ id: specifier, template: `@${specifier}` })

    await expect(renderMarkdownTemplate("@https://example.com/policy.md", {
      resolveImport,
    })).rejects.toThrow("must be a relative path")
    await expect(renderMarkdownTemplate("@./*.md", {
      resolveImport,
    })).rejects.toThrow("cannot use globs")
    await expect(renderMarkdownTemplate("@./missing.md", {
      resolveImport: async () => undefined,
    })).rejects.toThrow("could not be resolved")
    await expect(renderMarkdownTemplate("@./a.md", {
      resolveImport: async () => ({ id: "/root.md", template: "Again" }),
      sourceId: "/root.md",
    })).rejects.toThrow("Circular Markdown template import")
    await expect(renderMarkdownTemplate("@./a.md", {
      maxImportDepth: 1,
      resolveImport,
    })).rejects.toThrow("import depth exceeded 1")
  })

  it("rejects missing, null, and non-scalar values", async () => {
    await expect(renderMarkdownTemplate("{{ missing }}")).rejects.toThrow("is not defined")
    await expect(renderMarkdownTemplate("{{ value }}", { data: { value: null } })).rejects.toThrow("is not defined")
    await expect(renderMarkdownTemplate("{{ value }}", { data: { value: {} } })).rejects.toThrow("scalar value")
    await expect(renderMarkdownTemplate("{{{ missing }}}")).rejects.toThrow("is not defined")
    await expect(renderMarkdownTemplate("{{{ value }}}", { data: { value: false } })).rejects.toThrow("string")
  })

  it("rejects unsafe expressions and malformed branch chains", async () => {
    await expect(renderMarkdownTemplate("::if{name === 'call()'}\nYes\n::", {
      data: { name: "call()" },
    })).resolves.toBe("Yes")
    await expect(renderMarkdownTemplate("::if{process.exit()}\nNo\n::"))
      .rejects.toThrow("Unsafe Markdown template condition")
    await expect(renderMarkdownTemplateInternal("::if{private.enabled}\nNo\n::", {
      data: { private: { enabled: true } },
      validateConditionPath: path => path.startsWith("public."),
    })).rejects.toThrow("Unsafe Markdown template condition")
    await expect(renderMarkdownTemplate("::if{enabled}\nYes"))
      .rejects.toThrow("missing a closing")
    await expect(renderMarkdownTemplate("::if{enabled}\nYes\n::else{condition=\"admin\"}\nNo\n::"))
      .rejects.toThrow("else block does not accept a condition")
    await expect(renderMarkdownTemplate("::if{enabled}\nYes\n::else\nNo\n::else-if{admin}\nAdmin\n::"))
      .rejects.toThrow("else-if block cannot follow else")
  })

  it("only traverses own properties", async () => {
    const inherited = Object.create({ secret: "leak" }) as Record<string, unknown>
    inherited.visible = "shown"

    await expect(renderMarkdownTemplate("{{ secret }}", { data: inherited })).rejects.toThrow("is not defined")
    await expect(renderMarkdownTemplate("{{ visible }}", { data: inherited })).resolves.toBe("shown")
  })
})
