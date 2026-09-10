import { describe, expect, it } from "vitest"

import { renderMarkdownTemplateInternal } from "../src/internal/composition.ts"
import { renderMarkdownTemplate } from "../src/index.ts"

describe("renderMarkdownTemplate", () => {
  it("renders scalar data as Markdown text", async () => {
    expect(await renderMarkdownTemplate([
      "Hello {{ data.pullRequest.title }}.",
      "Attempt {{ data.count }} is {{ data.active }}.",
      "{{ data.routes.llm-route.choice }}",
      "{{ data.support.customer.name }}",
    ].join("\n"), {
      data: {
        active: true,
        count: 2,
        pullRequest: { title: "*untrusted* <policy>text</policy>" },
        routes: { "llm-route": { choice: "fast" } },
        support: { customer: { name: "Acme" } },
      },
    })).toBe([
      "Hello \\*untrusted\\* \\<policy>text\\</policy>.",
      "Attempt 2 is true.",
      "fast",
      "Acme",
    ].join("\n"))
  })

  it("renders scalar bindings as complete Markdown link destinations", async () => {
    await expect(renderMarkdownTemplate("[Open recap](){:href=\"data.url\"}", {
      data: { url: "https://prs.onmax.me/recap/2026-07" },
    })).resolves.toBe("[Open recap](https://prs.onmax.me/recap/2026-07)")

    await expect(renderMarkdownTemplate("[Open page](){:href=\"data.page\"}", {
      data: { page: 42 },
    })).resolves.toBe("[Open page](42)")

    await expect(renderMarkdownTemplate("[Open state](){:href=\"data.enabled\"}", {
      data: { enabled: true },
    })).resolves.toBe("[Open state](true)")

    await expect(renderMarkdownTemplate("[Open recap](){:href=\"data.url\"}", {
      data: { url: "/recap/July 2026_(final)?share=team&from=email#top" },
    })).resolves.toBe("[Open recap](/recap/July%202026_%28final%29?share=team&from=email#top)")

    await expect(renderMarkdownTemplate("[Open recap](){:href=\"data.url\"}", {
      data: { url: "https://example.com/recap/July%202026?signature=a%2Fb%3D" },
    })).resolves.toBe("[Open recap](https://example.com/recap/July%202026?signature=a%2Fb%3D)")

    await expect(renderMarkdownTemplate("[Open recap](){:href=\"data.url\"}", {
      data: { url: "https://example.com/?a=1&debug" },
    })).resolves.toBe("[Open recap](https://example.com/?a=1&debug)")

    await expect(renderMarkdownTemplate("[Open recap](){:href=\"data.url\"}", {
      data: { url: "https://example.com/?q=a\\b" },
    })).resolves.toBe("[Open recap](https://example.com/?q=a%5Cb)")

    await expect(renderMarkdownTemplate("[Open recap](){:href=\"data.url\"}", {
      data: { url: "/recap\u00A0" },
    })).resolves.toBe("[Open recap](/recap%C2%A0)")

    await expect(renderMarkdownTemplate("[Open item](){:href=\"data.url\"}", {
      data: { url: "web+demo:/folder\\item" },
    })).resolves.toBe("[Open item](web+demo:/folder%5Citem)")

    await expect(renderMarkdownTemplate("[Open item](){:href=\"data.url\"}", {
      data: { url: "web+demo://host/folder\\item" },
    })).resolves.toBe("[Open item](web+demo://host/folder%5Citem)")

    await expect(renderMarkdownTemplate("[Open recap](){:href=\"data.url\"}", {
      data: { url: "https://example.com/a) [Injected](https://evil.test?q=\"x\"" },
    })).resolves.toBe("[Open recap](https://example.com/a%29%20%5BInjected%5D%28https://evil.test?q=%22x%22)")

    await expect(renderMarkdownTemplate("[Open recap](placeholder \"Monthly recap\"){:href=\"data.url\"}", {
      data: { url: "https://prs.onmax.me/recap/2026-07" },
    })).resolves.toBe("[Open recap](https://prs.onmax.me/recap/2026-07){title=\"Monthly recap\"}")

    await expect(renderMarkdownTemplate("[Open recap](placeholder \"Monthly recap\"){:href=\"data.url\"}", {
      data: { url: "https://prs.onmax.me/recap/2026-07" },
    })).resolves.toBe("[Open recap](https://prs.onmax.me/recap/2026-07){title=\"Monthly recap\"}")
  })

  it("rejects unsafe Markdown link destinations", async () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "https://example.com/first\n[Injected](https://evil.test)",
      " https://example.com/recap",
      "https://example.com/recap ",
      "https://example.com/\uD800",
      "https://example.com/%zz",
      "https://example.com/?q=%",
      "https://example.com/a\\b",
      "https://example.com/?x=&#x29;*Injected*",
      "https://example.com/?x=&#65/foo",
      "https://example.com/?x=&copy/foo",
      "https://example.com/?a=1&amp;b=2",
      "http://[::1]/recap",
      "http:[::1]/recap",
      "ftp:/[::1]/recap",
      "//[::1]/recap",
      "///[::1]/recap",
    ]) {
      await expect(renderMarkdownTemplate("[Open recap](){:href=\"data.url\"}", { data: { url } }))
        .rejects.toThrow("must resolve to a safe destination")
    }

    await expect(renderMarkdownTemplate("[Open recap](){:href=\"data.url\"}"))
      .rejects.toThrow("binding \"data.url\" is not defined")
    await expect(renderMarkdownTemplate("[Open recap](){:href=\"data.url\"}", { data: { url: {} } }))
      .rejects.toThrow("must resolve to a scalar value")

    await expect(renderMarkdownTemplate([
      "::if{:condition=\"data.enabled\"}",
      "[Open recap](){:href=\"data.missing\"}",
      "::else",
      "No recap",
      "::\n::",
    ].join("\n"), { data: { enabled: false } })).resolves.toBe("No recap")
  })

  it("keeps scalar bindings in other Markdown destinations unchanged", async () => {
    await expect(renderMarkdownTemplate("[Open item](/items/{{ data.id }})", {
      data: { id: "abc" },
    })).resolves.toBe("\\[Open item\\](/items/abc)")

    await expect(renderMarkdownTemplate("![Preview]({{ data.url }})", {
      data: { url: "https://example.com/preview.png" },
    })).resolves.toBe("!\\[Preview\\](https://example.com/preview.png)")

    await expect(renderMarkdownTemplate("[Open item][item]\n\n[item]: {{ data.url }}", {
      data: { url: "https://example.com/item" },
    })).resolves.toBe("\\[Open item\\][item]\n\n[item]: https://example.com/item")
  })

  it("renders Markdown fragments without recursively evaluating template syntax", async () => {
    const template = [
      "# Review",
      ":markdown{:value=\"data.sections.body\"}",
      "",
      "Use (<Markdown :value=\"data.sections.inline\"></Markdown>).",
    ].join("\n")

    expect(await renderMarkdownTemplate(template, {
      data: {
        pullRequest: { available: true, repository: "vite-hub/vitehub" },
        sections: {
          body: [
            "## Body",
            "Use **bold** [guidance](https://example.com).",
            "{{ data.pullRequest.repository }}",
            "::if{:condition=\"data.pullRequest.available\"}",
            "Keep this branch literal.",
            "::",
            "@./literal.md",
          ].join("\n"),
          inline: "**raw Markdown**",
        },
      },
    })).toBe([
      "# Review",
      "",
      "## Body",
      "",
      "Use **bold** [guidance](https://example.com).",
      "{{ data.pullRequest.repository }}",
      "",
      "::if{:condition=\"data.pullRequest.available\"}",
      "Keep this branch literal.",
      "::",
      "",
      "@./literal.md",
      "",
      "Use (**raw Markdown**).",
    ].join("\n"))
  })

  it("rejects block Markdown in an inline fragment slot", async () => {
    await expect(renderMarkdownTemplate("Use (<Markdown :value=\"data.section\"></Markdown>).", {
      data: { section: "## Block heading" },
    })).rejects.toThrow("cannot contain block Markdown when used inline")
    await expect(renderMarkdownTemplate("**Prefix** :markdown{:value=\"data.section\"}", {
      data: { section: "## Block heading" },
    })).rejects.toThrow("cannot contain block Markdown when used inline")
    await expect(renderMarkdownTemplate(":markdown{:value=\"data.section\"} [suffix](https://example.com)", {
      data: { section: "## Block heading" },
    })).rejects.toThrow("cannot contain block Markdown when used inline")
  })

  it("separates consecutive standalone fragments selected by branches", async () => {
    expect(await renderMarkdownTemplate([
      "::if{:condition=\"data.sections.title\"}",
      ":markdown{:value=\"data.sections.title\"}",
      "::",
      "::if{:condition=\"data.sections.body\"}",
      ":markdown{:value=\"data.sections.body\"}",
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
      "::if{:condition=\"data.pullRequest.available\" :value=\"data.pullRequest.draft\" :eq=\"true\"}",
      "Draft",
      "::else-if{:condition=\"data.pullRequest.available\" :value=\"data.pullRequest.kind\" eq=\"review\"}",
      "Review",
      "::else",
      "Missing",
      "::\n::\n::",
    ].join("\n")

    await expect(renderMarkdownTemplate(template, {
      data: { pullRequest: { available: true, draft: false, kind: "review" } },
    })).resolves.toBe("Review")
  })

  it.each([
    ["eq", 3, 3, true], ["eq", 3, "3", false], ["neq", 3, 4, true],
    ["gt", 4, 3, true], ["gt", 3, 3, false], ["gte", 3, 3, true],
    ["lt", 2, 3, true], ["lte", 3, 3, true], ["lte", 4, 3, false],
    ["gt", "b", "a", true], ["gt", "4", 3, false],
    ["neq", undefined, 3, false], ["eq", undefined, undefined, false],
    ["eq", false, false, true], ["eq", 0, 0, true],
  ])("compares %s with %s and %s", async (operator, value, expected, selected) => {
    await expect(renderMarkdownTemplate(`::if{:value="data.value" :${operator}="data.expected"}\nYes\n::else\nNo\n::\n::`, {
      data: { value, expected },
    })).resolves.toBe(selected ? "Yes" : "No")
  })

  it("requires all comparisons and the optional condition to match", async () => {
    const template = '::if{:condition="data.enabled" :value="data.count" :gte="2" :lt="5"}\nYes\n::else\nNo\n::\n::'
    for (const [enabled, count, expected] of [[true, 3, "Yes"], [false, 3, "No"], [true, 5, "No"]] as const) {
      await expect(renderMarkdownTemplate(template, { data: { enabled, count } })).resolves.toBe(expected)
    }
  })

  it("renders nested branch chains and the content following them", async () => {
    const template = `::if{:condition="data.enabled"}
Before
::if{:value="data.count" :gt="0"}
Positive
::else
Empty
::
::
After
::else
Disabled
::
::
Outside`
    await expect(renderMarkdownTemplate(template, { data: { enabled: true, count: 1 } }))
      .resolves.toBe("Before\n\nPositive\n\nAfter\n\nOutside")
    await expect(renderMarkdownTemplate(template, { data: { enabled: false } }))
      .resolves.toBe("Disabled\n\nOutside")
  })

  it("selects explicitly closed sibling branch components", async () => {
    const template = `::if{:condition="data.ready"}
Ready
::else-if{:condition="data.waiting"}
Waiting
::
::else
Unavailable
::
::`
    for (const [ready, waiting, expected] of [[true, true, "Ready"], [false, true, "Waiting"], [false, false, "Unavailable"]] as const) {
      await expect(renderMarkdownTemplate(template, { data: { ready, waiting } })).resolves.toBe(expected)
    }
  })

  it("keeps nested inherited properties unavailable to bindings and comparisons", async () => {
    const account = Object.freeze(Object.assign(Object.create({ role: "admin" }), { name: "Acme" }))
    await expect(renderMarkdownTemplate("{{ data.account.name }}", { data: { account } })).resolves.toBe("Acme")
    await expect(renderMarkdownTemplate('::if{:value="data.account.role" eq="admin"}\nAdmin\n::else\nGuest\n::\n::', { data: { account } }))
      .resolves.toBe("Guest")
    await expect(renderMarkdownTemplate("{{ data.account.role }}", { data: { account } })).rejects.toThrow("is not defined")
  })

  it("preserves authored XML-style tags", async () => {
    expect(await renderMarkdownTemplate("<policy>Use {{ data.customer.name }}.</policy>", {
      data: { customer: { name: "Acme" } },
    })).toBe("<policy>Use Acme.</policy>")
  })

  it("renders scalar bindings in quoted XML attributes", async () => {
    expect(await renderMarkdownTemplate("<policy :audience=\"data.audience\" :tone=\"data.tone\">Use it.</policy>", {
      data: {
        audience: "A \"technical\" & safe audience",
        tone: "reviewer's <direct> tone",
      },
    })).toBe("<policy audience=\"A &quot;technical&quot; &amp; safe audience\" tone=\"reviewer's &lt;direct&gt; tone\">Use it.</policy>")

    await expect(renderMarkdownTemplate("<policy :audience=\"data.audience\">Use it.</policy>"))
      .rejects.toThrow("binding \"data.audience\" is not defined")
  })

  it("only renders tag attribute bindings in the selected branch", async () => {
    await expect(renderMarkdownTemplate([
      "::if{:condition=\"data.enabled\"}",
      "<policy :audience=\"data.missing\">Hidden</policy>",
      "::else",
      "Visible",
      "::\n::",
    ].join("\n"), {
      data: { enabled: false },
    })).resolves.toBe("Visible")
  })

  it("composes the full template language inside multiline XML blocks", async () => {
    expect(await renderMarkdownTemplate([
      "<policy>",
      "Use {{ data.customer.name }}.",
      "::if{:condition=\"data.enabled\"}",
      ":markdown{:value=\"data.section\"}",
      "@./detail.md",
      "::",
      "</policy>",
    ].join("\n"), {
      data: {
        customer: { name: "Acme" },
        enabled: true,
        section: "**Trusted** guidance.",
      },
    })).toBe([
      "<policy>",
      "Use Acme.",
      "",
      "",
      "**Trusted** guidance.",
      "",
      "@./detail.md",
      "</policy>",
    ].join("\n"))
  })

  it("keeps bindings, fragments, branches, and imports literal in code", async () => {
    const template = [
      "`{{ data.name }}`",
      "``:markdown{:value=\"data.section\"}``",
      "```md",
      "{{ data.name }}",
      ":markdown{:value=\"data.section\"}",
      "::if{:condition=\"data.enabled\"}",
      "@./ignored.md",
      "::",
      "<policy :audience=\"data.name\">literal</policy>",
      "```",
      "",
      "    {{ data.name }}",
      "    :markdown{:value=\"data.section\"}",
      "    ::if{:condition=\"data.enabled\"}",
      "    @./ignored.md",
      "    ::",
      "",
      "``{{ data.name }}",
      ":markdown{:value=\"data.section\"}",
      "::if{:condition=\"data.enabled\"}",
      "@./ignored.md",
      "::",
      "``",
      "",
      "@./used.md",
    ].join("\n")

    expect(await renderMarkdownTemplate(template, {
      data: { enabled: true, name: "Acme", section: "Rendered" },
    })).toBe([
      "`{{ data.name }}`",
      "`:markdown{:value=\"data.section\"}`",
      "",
      "```md",
      "{{ data.name }}",
      ":markdown{:value=\"data.section\"}",
      "::if{:condition=\"data.enabled\"}",
      "@./ignored.md",
      "::",
      "<policy :audience=\"data.name\">literal</policy>",
      "```",
      "",
      "```",
      "{{ data.name }}",
      ":markdown{:value=\"data.section\"}",
      "::if{:condition=\"data.enabled\"}",
      "@./ignored.md",
      "::",
      "```",
      "",
      "`{{ data.name }} :markdown{:value=\"data.section\"} ::if{:condition=\"data.enabled\"} @./ignored.md :: `",
      "",
      "@./used.md",
    ].join("\n"))
  })

  it.each([
    ["fenced", "```md\n::else\n::if{:condition=\"data.missing\"}\n{{ data.missing }}\n```"],
    ["indented", "    ::else\n    ::if{:condition=\"data.missing\"}\n    {{ data.missing }}"],
    ["multiline inline", "``\n::else\n::if{:condition=\"data.missing\"}\n{{ data.missing }}\n``"],
  ])("ignores malformed branches in %s code while validating authored branches", async (_kind, code) => {
    const template = `::if{:condition=\"data.enabled\"}\nSelected\n\n${code}\n\n::else-if{:condition=\"data.fallback\"}\nFallback\n::else\nNeither\n::\n::\n::`
    const selected = await renderMarkdownTemplate(template, { data: { enabled: true } })
    expect(selected).toContain("Selected")
    expect(selected).toContain("::else")
    expect(selected).toContain("::if{:condition=\"data.missing\"}")
    expect(selected).toContain("{{ data.missing }}")
    expect(selected).not.toContain("VITEHUBMARKDOWNTEMPLATE")
    await expect(renderMarkdownTemplate(template, { data: { enabled: false, fallback: true } }))
      .resolves.toBe("Fallback")
    await expect(renderMarkdownTemplate(template, { data: { enabled: false, fallback: false } }))
      .resolves.toBe("Neither")
    await expect(renderMarkdownTemplate(`${code}\n\n::if{:condition=\"data.enabled\"}\nUnclosed`))
      .rejects.toThrow("missing a closing")
  })

  it("isolates protected syntax across concurrent renders and a rejected render", async () => {
    const template = "`{{ data.literal }}`\n\n<policy :name=\"data.name\">\n::if{:condition=\"data.enabled\"}\n:markdown{:value=\"data.section\"}\n::else\nHidden\n::\n::\n</policy>"
    const results = await Promise.allSettled([
      renderMarkdownTemplate(template, { data: { enabled: true, name: "First", section: "First fragment" } }),
      renderMarkdownTemplate(template, { data: { enabled: true, name: "Missing section" } }),
      renderMarkdownTemplate(template, { data: { enabled: false, name: "Last" } }),
    ])
    expect(results[0]).toEqual({ status: "fulfilled", value: "`{{ data.literal }}`\n\n<policy name=\"First\">\nFirst fragment\n</policy>" })
    expect(results[1].status).toBe("rejected")
    expect(results[2]).toEqual({ status: "fulfilled", value: "`{{ data.literal }}`\n\n<policy name=\"Last\">\nHidden\n</policy>" })
  })

  it("preserves blank lines inside fenced code", async () => {
    await expect(renderMarkdownTemplate("```md\nfirst\n\n\nlast\n```"))
      .resolves.toBe("```md\nfirst\n\n\nlast\n```")
  })

  it("does not expose internal placeholders or render handlers", async () => {
    const authored = [
      ":markdown-template-raw{value=\"Injected\"}",
      "%%VITEHUB_MARKDOWN_TEMPLATE_FRAGMENT_0%%",
      ":markdown{:value=\"data.section\"}",
    ].join("\n")
    const rendered = await renderMarkdownTemplate(authored, { data: { section: "Rendered" } })

    expect(rendered).toContain("markdown-template-raw")
    expect(rendered).toContain("%%VITEHUB_MARKDOWN_TEMPLATE_FRAGMENT_0%%")
    expect(rendered).toContain("Rendered")
    expect(rendered).not.toBe("Injected")
  })

  it("keeps former import syntax literal", async () => {
    const template = "@./missing.md @../policy.md @workspace.policy @https://example.com/policy.md"
    await expect(renderMarkdownTemplate(template)).resolves.toBe(template)
  })

  it("rejects missing, null, and non-scalar values", async () => {
    await expect(renderMarkdownTemplate("{{ data.missing }}")).rejects.toThrow("is not defined")
    await expect(renderMarkdownTemplate("{{ data.value }}", { data: { value: null } })).rejects.toThrow("is not defined")
    await expect(renderMarkdownTemplate("{{ data.value }}", { data: { value: {} } })).rejects.toThrow("scalar value")
    await expect(renderMarkdownTemplate(":markdown{:value=\"data.missing\"}")).rejects.toThrow("is not defined")
    await expect(renderMarkdownTemplate(":markdown{:value=\"data.value\"}", { data: { value: false } })).rejects.toThrow("string")
  })

  it("rejects unsafe expressions and malformed branch chains", async () => {
    await expect(renderMarkdownTemplate("::if{:value=\"data.name\" eq=\"call()\"}\nYes\n::", {
      data: { name: "call()" },
    })).resolves.toBe("Yes")
    await expect(renderMarkdownTemplate("::if{process.exit()}\nNo\n::"))
      .rejects.toThrow("requires a condition or value prop")
    await expect(renderMarkdownTemplateInternal("::if{:condition=\"data.private.enabled\"}\nNo\n::", {
      data: { private: { enabled: true } },
      validateConditionPath: path => path.startsWith("public."),
    })).rejects.toThrow("Unsafe Markdown template condition")
    await expect(renderMarkdownTemplate("::if{:condition=\"data.enabled\"}\nYes"))
      .rejects.toThrow("missing a closing")
    await expect(renderMarkdownTemplate("::if{:condition=\"data.enabled\"}\nYes\n::else{condition=\"admin\"}\nNo\n::\n::"))
      .rejects.toThrow("else block does not accept a condition")
    await expect(renderMarkdownTemplate("::if{:condition=\"data.enabled\"}\nYes\n::else\nNo\n::else-if{:condition=\"data.admin\"}\nAdmin\n::\n::\n::"))
      .rejects.toThrow("else-if block cannot follow else")
  })

  it("only traverses own properties", async () => {
    const inherited = Object.create({ secret: "leak" }) as Record<string, unknown>
    inherited.visible = "shown"

    await expect(renderMarkdownTemplate("{{ data.secret }}", { data: inherited })).rejects.toThrow("is not defined")
    await expect(renderMarkdownTemplate("{{ data.visible }}", { data: inherited })).resolves.toBe("shown")
  })
})
