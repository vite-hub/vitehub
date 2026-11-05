import { describe, expect, it } from "vitest"

import { toRawMarkdown, type RawMarkdownOptions } from "../src/raw.ts"

// The site serves raw pages from one origin, so most cases check absolute links against it.
function convert(source: string, options: RawMarkdownOptions = {}): string {
  return toRawMarkdown(source, { siteUrl: "https://vitehub.dev", ...options })
}

describe("toRawMarkdown", () => {
  it.each([
    { mode: "builtin", label: "Built-in channels" },
    { mode: "custom", label: "Example connectors" },
  ])("keeps the hero channel information in $mode mode", ({ mode, label }) => {
    const raw = convert(`::product-hero{tagline="Reach your Agent." channels="Web chat, Slack" channel-mode="${mode}"}\n::`)
    expect(raw).toContain(`${label}: Web chat, Slack.`)
    expect(raw.includes("You write each connector. Use Agent Channels for built-in chat integrations.")).toBe(mode === "custom")
  })

  it("renders product landings as text and preserves component syntax in code examples", () => {
    const example = ':::product-feature-item{title="Example" to="/docs/example"}\nExample description.\n:::'
    const raw = convert([
      '---',
      'title: Storage',
      '---',
      '::product-hero{tagline="Save values by key." hosts="Node, Cloudflare"}',
      '  :::product-files',
      '  ```ts [server/api/value.ts]',
      '  const value = "::literal"',
      '  ```',
      '  :::',
      '::',
      '',
      '::product-features',
      '  :::product-feature-item{title="Read a value" icon="i-lucide-key" to="/docs/storage/read"}',
      '  Read with `get()`.',
      '  :::',
      "  :::product-feature-item{title='Write a value' to='./write'}",
      '  Save with `set()`.',
      '  :::',
      '::',
      '',
      '````md',
      example,
      '````',
      '',
      '~~~md',
      example,
      '~~~',
      '',
      '    :::product-feature-item{title="Indented example"}',
    ].join('\n'), { pagePath: '/docs/storage/overview' })

    expect(raw).toBe([
      '# Storage',
      '',
      'Save values by key.',
      '',
      'Hosts: Node, Cloudflare.',
      '',
      '```ts [server/api/value.ts]',
      'const value = "::literal"',
      '```',
      '',
      '### [Read a value](https://vitehub.dev/docs/storage/read)',
      '',
      'Read with `get()`.',
      '### [Write a value](https://vitehub.dev/docs/storage/write)',
      '',
      'Save with `set()`.',
      '',
      '````md',
      example,
      '````',
      '',
      '~~~md',
      example,
      '~~~',
      '',
      '    :::product-feature-item{title="Indented example"}',
      '',
    ].join('\n'))
  })

  it("keeps site-relative links relative without a site URL", () => {
    expect(toRawMarkdown("[Get started](/docs/kv/get-started)")).toBe("[Get started](/docs/kv/get-started)\n")
    expect(toRawMarkdown("[Get started](/docs/kv/get-started)", { siteUrl: "https://example.com/" })).toBe("[Get started](https://example.com/docs/kv/get-started)\n")
  })

  it("resolves document-relative links against the rendered page in a mounted app", () => {
    const raw = convert('[Next](./next) ![Image](../assets/a.png) [Bare](next?q=1#part) [Root](/docs/start) [Anchor](#part) [Mail](mailto:a@example.com) [CDN](//cdn.example.com/a)\n\n[ref]: ../guide "Guide"', { siteUrl: "https://example.com/portal", pagePath: "/docs/start/current" })
    expect(raw).toContain("[Next](https://example.com/portal/docs/start/next)")
    expect(raw).toContain("![Image](https://example.com/portal/docs/assets/a.png)")
    expect(raw).toContain("[Bare](https://example.com/portal/docs/start/next?q=1#part)")
    expect(raw).toContain("[Root](https://example.com/portal/docs/start)")
    expect(raw).toContain("[Anchor](https://example.com/portal/docs/start/current#part)")
    expect(raw).toContain('[ref]: https://example.com/portal/docs/guide "Guide"')
    expect(raw).toContain("[Mail](mailto:a@example.com)")
    expect(raw).toContain("[CDN](//cdn.example.com/a)")
    expect(convert("[Next](./next)", { siteUrl: "" })).toBe("[Next](./next)\n")
  })

  it("preserves semantic indentation at document boundaries", () => {
    expect(convert("---\ntitle: Boundary\n---\n    first\n    second")).toBe("# Boundary\n\n    first\n    second\n")
    expect(convert("    first\n    second\n")).toBe("    first\n    second\n")
  })

  it("unwraps agent-only blocks for agents and omits them for the eval baseline", () => {
    const source = [
      "Shared intro.",
      "",
      "::agent-only{skill=\"kv\"}",
      "Agents read [Get started](/docs/kv/get-started).",
      "",
      "::note",
      "Nested note.",
      "::",
      "",
      "```md",
      "::",
      "```",
      "::",
      "",
      "Shared outro.",
    ].join("\n")

    const agents = convert(source)
    expect(agents).toContain("Agents read [Get started](https://vitehub.dev/docs/kv/get-started).")
    expect(agents).toContain("> **Note**\n\nNested note.")
    expect(agents).toContain("```md\n::\n```")
    expect(agents).toContain("Shared outro.")
    expect(agents).not.toContain("agent-only")

    const baseline = convert(source, { includeAgentOnly: false })
    expect(baseline).toContain("Shared intro.")
    expect(baseline).toContain("Shared outro.")
    expect(baseline).not.toContain("Agents read")
    expect(baseline).not.toContain("Nested note.")
  })

  it("inlines collapsible content for agents", () => {
    const raw = convert([
      "::collapsible{name=\"every option\"}",
      "| Option | Default |",
      "| --- | --- |",
      "| `driver` | `memory` |",
      "::",
    ].join("\n"))

    expect(raw).toBe("| Option | Default |\n| --- | --- |\n| `driver` | `memory` |\n")
  })

  it("unwraps the interactive support matrix for raw Markdown", () => {
    expect(convert([
      "::support-matrix",
      "## Server primitives",
      "",
      "| Host | Status |",
      "| --- | --- |",
      "| Local | Available |",
      "::",
    ].join("\n"))).toBe([
      "## Server primitives",
      "",
      "| Host | Status |",
      "| --- | --- |",
      "| Local | Available |",
      "",
    ].join("\n"))
  })

  it("parses YAML block scalar titles", () => {
    expect(convert("---\ntitle: >\n  Source-backed raw Markdown\n---\nBody")).toBe(
      "# Source-backed raw Markdown\n\nBody\n",
    )
  })

  it("accepts a frontmatter terminator at the end of the source", () => {
    const raw = convert("---\ntitle: Frontmatter only\n---")
    expect(raw).toContain("# Frontmatter only")
    expect(raw).not.toContain("title:")
    expect(raw).not.toContain("---")
  })

  it("makes rendered reference-style links portable", () => {
    expect(convert([
      "[Install][install]",
      "",
      "[install]: /docs/getting-started \"Get started\"",
      "[external]: https://example.com/docs",
      "",
      "```md",
      "[literal]: /docs/literal",
      "```",
      "",
      "<pre>",
      "[literal-html]: /docs/literal-html",
      "</pre>",
    ].join("\n"))).toBe([
      "[Install][install]",
      "",
      "[install]: https://vitehub.dev/docs/getting-started \"Get started\"",
      "[external]: https://example.com/docs",
      "",
      "```md",
      "[literal]: /docs/literal",
      "```",
      "",
      "<pre>",
      "[literal-html]: /docs/literal-html",
      "</pre>",
      "",
    ].join("\n"))
  })

  it("parses complete reference definitions before rewriting destinations", () => {
    const maximumNesting = `${"(".repeat(32)}leaf${")".repeat(32)}`
    const excessiveNesting = `${"(".repeat(33)}leaf${")".repeat(33)}`
    expect(convert([
      "> [quote\\]d]: /docs/quoted",
      "- [listed]: /docs/listed",
      "[continued]:",
      "  </docs/continued>",
      "[malformed]: </docs/malformed",
      "    [literal]: /docs/code",
      "- > [nested]: /docs/nested",
      "[unterminated]: /docs/no \"title",
      "[nested]: /docs/a(b(c)) 'Nested destination'",
      `[maximum-nesting]: /docs/${maximumNesting}`,
      `[excessive-nesting]: /docs/${excessiveNesting}`,
      "[malformed-title]: /docs/no \"a\" b\"",
      "[unbalanced-destination]: /docs/no(a(b)",
      "[a[b]: /docs/no",
    ].join("\n"))).toBe([
      "> [quote\\]d]: https://vitehub.dev/docs/quoted",
      "- [listed]: https://vitehub.dev/docs/listed",
      "[continued]:",
      "  <https://vitehub.dev/docs/continued>",
      "[malformed]: </docs/malformed",
      "    [literal]: /docs/code",
      "- > [nested]: https://vitehub.dev/docs/nested",
      "[unterminated]: /docs/no \"title",
      "[nested]: https://vitehub.dev/docs/a(b(c)) 'Nested destination'",
      `[maximum-nesting]: https://vitehub.dev/docs/${maximumNesting}`,
      `[excessive-nesting]: /docs/${excessiveNesting}`,
      "[malformed-title]: /docs/no \"a\" b\"",
      "[unbalanced-destination]: /docs/no(a(b)",
      "[a[b]: /docs/no",
      "",
    ].join("\n"))
  })

  it("handles inline destination and code-span grammar boundaries", () => {
    const maximumNesting = `${"(".repeat(32)}leaf${")".repeat(32)}`
    const excessiveNesting = `${"(".repeat(33)}leaf${")".repeat(33)}`
    expect(convert([
      "[Guide](</docs/getting started>)",
      "[Spaced]( /docs/spaced)",
      `[maximum nesting](/docs/${maximumNesting})`,
      `[excessive nesting](/docs/${excessiveNesting})`,
      "`[literal](/docs/literal)\\` [rendered](/docs/rendered)",
    ].join("\n"))).toBe([
      "[Guide](<https://vitehub.dev/docs/getting started>)",
      "[Spaced]( https://vitehub.dev/docs/spaced)",
      `[maximum nesting](https://vitehub.dev/docs/${maximumNesting})`,
      `[excessive nesting](/docs/${excessiveNesting})`,
      "`[literal](/docs/literal)\\` [rendered](https://vitehub.dev/docs/rendered)",
      "",
    ].join("\n"))
  })

  it("keeps reference definitions inside multiline code spans literal", () => {
    expect(convert([
      "`code",
      "[literal]: /docs/literal",
      "`",
      "[rendered]: /docs/rendered",
    ].join("\n"))).toContain([
      "`code",
      "[literal]: /docs/literal",
      "`",
      "[rendered]: https://vitehub.dev/docs/rendered",
    ].join("\n"))
  })

  it("ends unmatched code spans at inline block boundaries", () => {
    expect(convert([
      "before `",
      "# heading",
      "[ok]: /docs/ok",
      "closing `",
    ].join("\n"))).toContain("[ok]: https://vitehub.dev/docs/ok")
  })

  it("keeps link-like text inside inline HTML attributes literal", () => {
    expect(convert('<span title="[literal](/docs/literal)">label</span> [rendered](/docs/rendered)')).toBe(
      '<span title="[literal](/docs/literal)">label</span> [rendered](https://vitehub.dev/docs/rendered)\n',
    )
  })

  it("keeps link-like text inside multiline inline HTML literal", () => {
    expect(convert([
      "<span",
      " title =",
      ' "[literal](/docs/literal)"',
      ">label</span> [rendered](/docs/rendered)",
    ].join("\n"))).toBe([
      "<span",
      " title =",
      ' "[literal](/docs/literal)"',
      ">label</span> [rendered](https://vitehub.dev/docs/rendered)",
      "",
    ].join("\n"))
  })

  it("keeps link-like text inside inline HTML forms literal", () => {
    expect(convert([
      "Text <!-- [comment](/docs/comment) --> [rendered](/docs/rendered)",
      "Text <?instruction [literal](/docs/instruction)?> [rendered](/docs/rendered)",
      "Text <!DOCTYPE [literal](/docs/declaration)> [rendered](/docs/rendered)",
      "Text <![CDATA[[literal](/docs/cdata)]]> [rendered](/docs/rendered)",
    ].join("\n"))).toBe([
      "Text <!-- [comment](/docs/comment) --> [rendered](https://vitehub.dev/docs/rendered)",
      "Text <?instruction [literal](/docs/instruction)?> [rendered](https://vitehub.dev/docs/rendered)",
      "Text <!DOCTYPE [literal](/docs/declaration)> [rendered](https://vitehub.dev/docs/rendered)",
      "Text <![CDATA[[literal](/docs/cdata)]]> [rendered](https://vitehub.dev/docs/rendered)",
      "",
    ].join("\n"))
  })

  it("does not start type-7 HTML blocks inside paragraphs", () => {
    expect(convert([
      "Paragraph",
      "<custom-tag>",
      "[rendered](/docs/rendered)",
    ].join("\n"))).toContain("[rendered](https://vitehub.dev/docs/rendered)")
  })

  it("does not start type-7 HTML blocks inside list-item paragraphs", () => {
    expect(convert([
      "- Paragraph",
      "  <custom-tag>",
      "  [rendered](/docs/rendered)",
      "",
      "<custom-block>",
      "[literal](/docs/literal)",
    ].join("\n"))).toContain([
      "- Paragraph",
      "  <custom-tag>",
      "  [rendered](https://vitehub.dev/docs/rendered)",
      "",
      "<custom-block>",
      "[literal](/docs/literal)",
    ].join("\n"))
  })

  it("keeps type-7 HTML in lazy list-item paragraph continuations", () => {
    expect(convert([
      "- Paragraph",
      "<custom-tag>",
      "[rendered](/docs/rendered)",
    ].join("\n"))).toBe([
      "- Paragraph",
      "<custom-tag>",
      "[rendered](https://vitehub.dev/docs/rendered)",
      "",
    ].join("\n"))
  })

  it("keeps type-7 HTML in lazy blockquote paragraph continuations", () => {
    expect(convert([
      "> Paragraph",
      "<custom-tag>",
      "[rendered](/docs/rendered)",
      "::warning",
      "Rendered warning.",
      "::",
    ].join("\n"))).toContain([
      "> Paragraph",
      "<custom-tag>",
      "[rendered](https://vitehub.dev/docs/rendered)",
      "> **Warning**",
    ].join("\n"))
  })

  it("preserves indented page-grid examples", () => {
    const source = [
      "    ::u-page-grid",
      "      :::u-page-card",
      "      ---",
      "      title: Literal card",
      "      to: /docs/literal",
      "      ---",
      "      :::",
      "    ::",
    ].join("\n")
    expect(convert(source)).toBe(`${source}\n`)
  })

  it("converts page grids relative to list-item indentation", () => {
    expect(convert([
      "-   item",
      "",
      "    ::u-page-grid",
      "      :::u-page-card",
      "      ---",
      "      title: Listed page",
      "      to: /docs/listed",
      "      description: From a list",
      "      ---",
      "      :::",
      "    ::",
    ].join("\n"))).toContain("    - [Listed page](https://vitehub.dev/docs/listed) — From a list")
  })

  it("does not duplicate authored H1 forms", () => {
    expect(convert("---\ntitle: Frontmatter\n---\n#\tExisting heading")).toBe("#\tExisting heading\n")
    expect(convert("---\ntitle: Frontmatter\n---\nExisting heading\n================")).toBe(
      "Existing heading\n================\n",
    )
  })

  it("keeps contextual setext-like and malformed definition lines in paragraphs", () => {
    for (const preceding of ["===", "--", "[broken]: /docs/no \"title"]) {
      expect(convert([
        preceding,
        "<custom-tag>",
        "[rendered](/docs/rendered)",
      ].join("\n"))).toContain("[rendered](https://vitehub.dev/docs/rendered)")
    }
  })

  it("validates inline-link suffixes before rewriting", () => {
    expect(convert([
      "[literal](/docs/x nope)",
      "[titled](/docs/titled \"Title\")",
    ].join("\n"))).toContain([
      "[literal](/docs/x nope)",
      "[titled](https://vitehub.dev/docs/titled \"Title\")",
    ].join("\n"))
  })

  it("converts presentation directives after type-7-looking paragraph HTML", () => {
    expect(convert([
      "Paragraph",
      "<custom-tag>",
      "::warning",
      "Rendered warning.",
      "::",
    ].join("\n"))).toContain("> **Warning**")
  })

  it("starts type-7 HTML blocks after Markdown block boundaries", () => {
    expect(convert([
      "Paragraph",
      "",
      "<custom-blank>",
      "[blank literal](/docs/blank)",
      "",
      "# Heading",
      "<custom-heading>",
      "[heading literal](/docs/heading)",
      "",
      "- List item",
      "<custom-list>",
      "[list literal](/docs/list)",
    ].join("\n"))).toContain([
      "<custom-blank>",
      "[blank literal](/docs/blank)",
      "",
      "# Heading",
      "<custom-heading>",
      "[heading literal](/docs/heading)",
      "",
      "- List item",
      "<custom-list>",
      "[list literal](https://vitehub.dev/docs/list)",
    ].join("\n"))
  })

  it("keeps protected indented code separate from following references", () => {
    expect(convert([
      "    [literal]: /docs/literal",
      "[rendered]: /docs/rendered",
    ].join("\n"))).toBe([
      "    [literal]: /docs/literal",
      "[rendered]: https://vitehub.dev/docs/rendered",
      "",
    ].join("\n"))
  })

  it("preserves raw HTML blocks inside blockquotes", () => {
    expect(convert([
      "> <pre>",
      "> [literal](/docs/literal)",
      "> ::warning",
      "> </pre>",
      "[rendered](/docs/rendered)",
    ].join("\n"))).toBe([
      "> <pre>",
      "> [literal](/docs/literal)",
      "> ::warning",
      "> </pre>",
      "[rendered](https://vitehub.dev/docs/rendered)",
      "",
    ].join("\n"))
  })

  it("parses page-card metadata as YAML", () => {
    expect(convert([
      "::u-page-grid",
      "  :::u-page-card",
      "  ---",
      "  title: >",
      "    Agent Definitions",
      "  description: Source-backed docs.",
      "  to: /docs/agents",
      "  ---",
      "  :::",
      "::",
    ].join("\n"))).toBe("- [Agent Definitions](https://vitehub.dev/docs/agents) — Source-backed docs.\n")
  })

  it("rewrites links whose labels contain balanced brackets", () => {
    expect(convert([
      "[API [beta]](/docs/api)",
      "![Diagram [dark]](/images/dark.png)",
      "\\[Escaped [label]](/docs/escaped)",
    ].join("\n"))).toBe([
      "[API [beta]](https://vitehub.dev/docs/api)",
      "![Diagram [dark]](https://vitehub.dev/images/dark.png)",
      "\\[Escaped [label]](/docs/escaped)",
      "",
    ].join("\n"))
  })

  it("preserves invalid bare link destinations", () => {
    expect(convert([
      "[literal](/docs/<x>)",
      "[escaped](/docs/\\<x\\>)",
      "[spaced](/docs/a(b c))",
    ].join("\n"))).toBe([
      "[literal](/docs/<x>)",
      "[escaped](https://vitehub.dev/docs/\\<x\\>)",
      "[spaced](/docs/a(b c))",
      "",
    ].join("\n"))
  })

  it("keeps list-prefixed fence markers literal inside fenced examples", () => {
    expect(convert([
      "```md",
      "- ```",
      "[Literal link](/docs/literal)",
      "::warning",
      "Literal directive.",
      "::",
      "```",
      "[Rendered link](/docs/rendered)",
    ].join("\n"))).toBe([
      "```md",
      "- ```",
      "[Literal link](/docs/literal)",
      "::warning",
      "Literal directive.",
      "::",
      "```",
      "[Rendered link](https://vitehub.dev/docs/rendered)",
      "",
    ].join("\n"))
  })

  it("rejects backticks in backtick-fence info strings", () => {
    expect(convert([
      "```md `literal`",
      "[Rendered link](/docs/rendered)",
      "::warning",
      "Rendered directive.",
      "::",
    ].join("\n"))).toContain("[Rendered link](https://vitehub.dev/docs/rendered)")
  })

  it("preserves raw HTML blocks inside list items", () => {
    expect(convert([
      "- <pre>",
      "  [literal](/docs/literal)",
      "  ::warning",
      "  </pre>",
      "[rendered](/docs/rendered)",
    ].join("\n"))).toBe([
      "- <pre>",
      "  [literal](/docs/literal)",
      "  ::warning",
      "  </pre>",
      "[rendered](https://vitehub.dev/docs/rendered)",
      "",
    ].join("\n"))
  })

  it("preserves raw HTML in padded list continuations", () => {
    expect(convert([
      "-   item",
      "",
      "    <pre>",
      "    [literal](/docs/literal)",
      "    ::warning",
      "    </pre>",
      "[rendered](/docs/rendered)",
    ].join("\n"))).toContain([
      "    <pre>",
      "    [literal](/docs/literal)",
      "    ::warning",
      "    </pre>",
      "[rendered](https://vitehub.dev/docs/rendered)",
    ].join("\n"))
  })

  it("uses CommonMark list marker widths for fence and indentation parsing", () => {
    expect(convert([
      "1234567890. ```md",
      "[rendered](/docs/ten-digit-marker)",
      "-\titem",
      "",
      "      [list paragraph](/docs/list-paragraph)",
      "- - item",
      "",
      "      [nested list paragraph](/docs/nested-list-paragraph)",
    ].join("\n"))).toContain([
      "[rendered](https://vitehub.dev/docs/ten-digit-marker)",
      "-\titem",
      "",
      "      [list paragraph](https://vitehub.dev/docs/list-paragraph)",
      "- - item",
      "",
      "      [nested list paragraph](https://vitehub.dev/docs/nested-list-paragraph)",
    ].join("\n"))
  })

  it("measures presentation directive indentation from list content", () => {
    expect(convert([
      "-   item",
      "",
      "    ::warning",
      "    Rendered warning.",
      "    ::",
      "",
      "        ::tip",
      "        Literal indented code.",
      "        ::",
    ].join("\n"))).toBe([
      "-   item",
      "",
      "    > **Warning**",
      "",
      "    Rendered warning.",
      "",
      "        ::tip",
      "        Literal indented code.",
      "        ::",
      "",
    ].join("\n"))
  })

  it("preserves presentation content indentation inside semantic directives", () => {
    expect(convert([
      "::video{src=\"/demo.mp4\"}",
      "  ::warning",
      "    Nested warning.",
      "  ::",
      "::",
    ].join("\n"))).toBe([
      "::video{src=\"/demo.mp4\"}",
      "  > **Warning**",
      "",
      "  Nested warning.",
      "::",
      "",
    ].join("\n"))
  })

  it("keeps directives in non-list indented code literal", () => {
    expect(convert([
      "- - -",
      "    ::warning",
      "    Thematic-break-adjacent code.",
      "    ::",
      "",
      "    - item",
      "    ::tip",
      "    Root indented code.",
      "    ::",
    ].join("\n"))).toBe([
      "- - -",
      "    ::warning",
      "    Thematic-break-adjacent code.",
      "    ::",
      "",
      "    - item",
      "    ::tip",
      "    Root indented code.",
      "    ::",
      "",
    ].join("\n"))
  })

  it("keeps definition-looking lines inside open paragraphs literal", () => {
    expect(convert([
      "Paragraph",
      "[literal]: /docs/literal",
      "",
      "[definition]: /docs/definition",
    ].join("\n"))).toBe([
      "Paragraph",
      "[literal]: /docs/literal",
      "",
      "[definition]: https://vitehub.dev/docs/definition",
      "",
    ].join("\n"))
  })

  it("preserves fenced and raw HTML blocks in quoted list items", () => {
    expect(convert([
      "> - ```md",
      ">   [fenced literal](/docs/fenced)",
      ">   ::warning",
      ">   ```",
      "> - <pre>",
      ">   [HTML literal](/docs/html)",
      ">   ::warning",
      ">   </pre>",
      "[rendered](/docs/rendered)",
    ].join("\n"))).toBe([
      "> - ```md",
      ">   [fenced literal](/docs/fenced)",
      ">   ::warning",
      ">   ```",
      "> - <pre>",
      ">   [HTML literal](/docs/html)",
      ">   ::warning",
      ">   </pre>",
      "[rendered](https://vitehub.dev/docs/rendered)",
      "",
    ].join("\n"))
  })

  it("rewrites links in indented paragraph continuations", () => {
    expect(convert([
      "Paragraph",
      "    [rendered](/docs/rendered)",
    ].join("\n"))).toContain("    [rendered](https://vitehub.dev/docs/rendered)")
  })

  it("ends raw HTML blocks when their Markdown container exits", () => {
    expect(convert([
      "> <pre>",
      "> [quoted literal](/docs/quoted-literal)",
      "[rendered after quote](/docs/after-quote)",
      "::warning",
      "Rendered warning.",
      "::",
      "",
      "- <script>",
      "  [listed literal](/docs/listed-literal)",
      "[rendered after list](/docs/after-list)",
    ].join("\n"))).toBe([
      "> <pre>",
      "> [quoted literal](/docs/quoted-literal)",
      "[rendered after quote](https://vitehub.dev/docs/after-quote)",
      "> **Warning**",
      "",
      "Rendered warning.",
      "",
      "- <script>",
      "  [listed literal](/docs/listed-literal)",
      "[rendered after list](https://vitehub.dev/docs/after-list)",
      "",
    ].join("\n"))
  })

  it("publishes source-backed Markdown without presentation component serialization", () => {
    const raw = convert([
      "---",
      "title: ViteHub docs",
      "---",
      "",
      "::u-page-grid",
      "  :::u-page-card",
      "  ---",
      "  title: Get started",
      "  description: Run one local result.",
      "  to: /docs/getting-started",
      "  ---",
      "  :::",
      "::",
      "",
      "| Choice | Result |",
      "| --- | --- |",
      "| Local | Works |",
      "",
      "::warning",
      "Keep secrets out of examples.",
      "::",
      "",
      "    ::warning",
      "    This indented code block remains literal.",
      "    ::",
      "",
      "\t::tip",
      "\tThis tab-indented code block remains literal.",
      "\t::",
      "",
      "::steps",
      "      ::warning",
      "      This nested indented code block remains literal.",
      "      ::",
      "  \t  ::important",
      "  \t  This mixed-indentation code block remains literal.",
      "  \t  ::",
      "::",
      "",
      "[Rendered link](/docs/rendered) and `[literal link](/docs/literal)`.",
      "[`skills()`](/docs/agents/capabilities/skills) and [before `code` after](/docs/code-label).",
      "\\[escaped link](/docs/escaped-link) and \\![rendered link](/docs/escaped-image).",
      "Escaped \\` delimiter and [rendered link](/docs/escaped) \\` stay outside code.",
      "`multiline literal",
      "[link](/docs/multiline)` and [rendered link](/docs/after-code).",
      "Unmatched ````` run, then ``[literal link](/docs/after-unmatched)`` and [rendered link](/docs/outside-span).",
      "",
      "    [indented literal link](/docs/indented)",
      "\t[tab-indented literal link](/docs/tab-indented)",
      "- item",
      "    [list child](/docs/list-child)",
      "",
      ">     [blockquote code](/docs/blockquote-code)",
      "- item",
      "",
      "      [list code](/docs/list-code)",
      "`multiline code",
      "    indented continuation",
      "[multiline indented literal](/docs/multiline-indented)`",
      "",
      "::video{src=\"/demo.mp4\"}",
      "Keep this semantic directive.",
      "::",
      "",
      "```md",
      "::warning",
      "This is example source.",
      "::",
      "```",
      "",
      "````md",
      "```md",
      "::warning",
      "This nested fence remains literal.",
      "::",
      "```",
      "::u-page-grid",
      "````",
      "",
      "```md",
      "```js",
      "::warning",
      "This same-length marker with an info string remains literal.",
      "::",
      "::u-page-grid",
      "```",
      "",
      "~~~md",
      "~~~js",
      "::warning",
      "This tilde marker with an info string remains literal.",
      "::",
      "~~~",
      "",
      "- ```md",
      "  ::warning",
      "  This list-nested fence remains literal.",
      "  ::",
      "  ```",
      "",
      "- ```md",
      "  [unclosed list literal](/docs/unclosed-list-literal)",
      "",
      "[rendered after unclosed list fence](/docs/after-unclosed-list-fence)",
      "",
      "    ```md",
      "    [code-indented fence literal](/docs/code-indented-fence)",
      "",
      "[rendered after code-indented fence](/docs/after-code-indented-fence)",
      "",
      "```md",
      "```\u00a0",
      "::warning",
      "This Unicode-suffixed marker remains literal.",
      "::",
      "```",
      "",
      "<pre>",
      "[raw HTML literal](/docs/raw-html-literal)",
      "::warning",
      "Raw HTML directive remains literal.",
      "::",
      "::u-page-grid",
      "  :::u-page-card",
      "  ---",
      "  title: Raw HTML card",
      "  to: /docs/raw-html-card",
      "  ---",
      "  :::",
      "::",
      "</pre>",
      "[rendered after raw HTML](https://vitehub.dev/docs/already-absolute)",
      "",
      "<div>",
      "::warning",
      "Raw block tag directive remains literal.",
      "::",
      "[raw block tag link](/docs/raw-block-tag)",
      "</div>",
      "",
      "<!--",
      "::warning",
      "[raw comment link](/docs/raw-comment)",
      "-->",
      "<!-- closed -->",
      "[rendered after one-line comment](/docs/after-one-line-comment)",
      "<?closed?>",
      "[rendered after processing instruction](/docs/after-processing-instruction)",
      "<!DOCTYPE html>",
      "[rendered after declaration](/docs/after-declaration)",
      "<![CDATA[closed]]>",
      "[rendered after CDATA](/docs/after-cdata)",
      "",
      "> ~~~md",
      "> [blockquote literal](/docs/blockquote-literal)",
      "> ~~~",
      "",
      "- > ```md",
      "  > [list blockquote literal](/docs/list-blockquote-literal)",
      "  > ```",
      "",
      "> ```md",
      "> [unclosed blockquote literal](/docs/unclosed-blockquote-literal)",
      "",
      "[rendered after unclosed blockquote](/docs/after-unclosed-blockquote)",
      "",
      "::steps",
      "  ::tabs",
      "    :::tabs-item{label=\"Example\"}",
      "      ```md",
      "      ::u-page-grid",
      "        :::u-page-card",
      "        ---",
      "        title: Literal card",
      "        ---",
      "        :::",
      "      ::",
      "        nested: value",
      "      ```",
      "    :::",
      "  ::",
      "::",
      "",
      "::tabs",
      "  ::u-page-grid",
      "    :::u-page-card",
      "    ---",
      "    title: Nested card",
      "    to: /docs/nested-card",
      "    ---",
      "    :::",
      "  ::",
      "::",
    ].join("\n"))

    expect(raw).toContain("# ViteHub docs")
    expect(raw).toContain("- [Get started](https://vitehub.dev/docs/getting-started) — Run one local result.")
    expect(raw).toContain("| Choice | Result |")
    expect(raw).toContain("> **Warning**")
    expect(raw).toContain("    ::warning\n    This indented code block remains literal.\n    ::")
    expect(raw).toContain("\t::tip\n\tThis tab-indented code block remains literal.\n\t::")
    expect(raw).toContain("    ::warning\n    This nested indented code block remains literal.\n    ::")
    expect(raw).toContain("\t  ::important\n\t  This mixed-indentation code block remains literal.\n\t  ::")
    expect(raw).toContain("[Rendered link](https://vitehub.dev/docs/rendered) and `[literal link](/docs/literal)`.")
    expect(raw).toContain("[`skills()`](https://vitehub.dev/docs/agents/capabilities/skills) and [before `code` after](https://vitehub.dev/docs/code-label).")
    expect(raw).toContain("\\[escaped link](/docs/escaped-link) and \\![rendered link](https://vitehub.dev/docs/escaped-image).")
    expect(raw).toContain("Escaped \\` delimiter and [rendered link](https://vitehub.dev/docs/escaped) \\` stay outside code.")
    expect(raw).toContain("`multiline literal\n[link](/docs/multiline)` and [rendered link](https://vitehub.dev/docs/after-code).")
    expect(raw).toContain("Unmatched ````` run, then ``[literal link](/docs/after-unmatched)`` and [rendered link](https://vitehub.dev/docs/outside-span).")
    expect(raw).toContain("    [indented literal link](/docs/indented)")
    expect(raw).toContain("\t[tab-indented literal link](/docs/tab-indented)")
    expect(raw).toContain("- item\n    [list child](https://vitehub.dev/docs/list-child)")
    expect(raw).toContain(">     [blockquote code](/docs/blockquote-code)")
    expect(raw).toContain("- item\n\n      [list code](/docs/list-code)")
    expect(raw).toContain("`multiline code\n    indented continuation\n[multiline indented literal](/docs/multiline-indented)`")
    expect(raw).toContain("::video{src=\"/demo.mp4\"}\nKeep this semantic directive.\n::")
    expect(raw).toContain("```md\n::warning\nThis is example source.\n::\n```")
    expect(raw).toContain([
      "````md",
      "```md",
      "::warning",
      "This nested fence remains literal.",
      "::",
      "```",
      "::u-page-grid",
      "````",
    ].join("\n"))
    expect(raw).toContain([
      "```md",
      "```js",
      "::warning",
      "This same-length marker with an info string remains literal.",
      "::",
      "::u-page-grid",
      "```",
    ].join("\n"))
    expect(raw).toContain([
      "~~~md",
      "~~~js",
      "::warning",
      "This tilde marker with an info string remains literal.",
      "::",
      "~~~",
    ].join("\n"))
    expect(raw).toContain([
      "- ```md",
      "  ::warning",
      "  This list-nested fence remains literal.",
      "  ::",
      "  ```",
    ].join("\n"))
    expect(raw).toContain("- ```md\n  [unclosed list literal](/docs/unclosed-list-literal)")
    expect(raw).toContain("[rendered after unclosed list fence](https://vitehub.dev/docs/after-unclosed-list-fence)")
    expect(raw).toContain("    ```md\n    [code-indented fence literal](/docs/code-indented-fence)")
    expect(raw).toContain("[rendered after code-indented fence](https://vitehub.dev/docs/after-code-indented-fence)")
    expect(raw).toContain("```md\n```\u00a0\n::warning\nThis Unicode-suffixed marker remains literal.\n::\n```")
    expect(raw).toContain([
      "<pre>",
      "[raw HTML literal](/docs/raw-html-literal)",
      "::warning",
      "Raw HTML directive remains literal.",
      "::",
      "::u-page-grid",
      "  :::u-page-card",
      "  ---",
      "  title: Raw HTML card",
      "  to: /docs/raw-html-card",
      "  ---",
      "  :::",
      "::",
      "</pre>",
    ].join("\n"))
    expect(raw).toContain("<div>\n::warning\nRaw block tag directive remains literal.\n::\n[raw block tag link](/docs/raw-block-tag)\n</div>")
    expect(raw).toContain("<!--\n::warning\n[raw comment link](/docs/raw-comment)\n-->")
    expect(raw).toContain("<!-- closed -->\n[rendered after one-line comment](https://vitehub.dev/docs/after-one-line-comment)")
    expect(raw).toContain("<?closed?>\n[rendered after processing instruction](https://vitehub.dev/docs/after-processing-instruction)")
    expect(raw).toContain("<!DOCTYPE html>\n[rendered after declaration](https://vitehub.dev/docs/after-declaration)")
    expect(raw).toContain("<![CDATA[closed]]>\n[rendered after CDATA](https://vitehub.dev/docs/after-cdata)")
    expect(raw).toContain("> ~~~md\n> [blockquote literal](/docs/blockquote-literal)\n> ~~~")
    expect(raw).toContain("- > ```md\n  > [list blockquote literal](/docs/list-blockquote-literal)\n  > ```")
    expect(raw).toContain("> ```md\n> [unclosed blockquote literal](/docs/unclosed-blockquote-literal)")
    expect(raw).toContain("[rendered after unclosed blockquote](https://vitehub.dev/docs/after-unclosed-blockquote)")
    expect(raw).toContain([
      "### Example",
      "",
      "```md",
      "::u-page-grid",
      "  :::u-page-card",
      "  ---",
      "  title: Literal card",
      "  ---",
      "  :::",
      "::",
      "  nested: value",
      "```",
    ].join("\n"))
    expect(raw).toContain("- [Nested card](https://vitehub.dev/docs/nested-card)")
    expect(raw).not.toMatch(/<u-|<table/)
  })
})
