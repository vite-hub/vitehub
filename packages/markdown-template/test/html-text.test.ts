import { describe, expect, it } from "vitest"

import { htmlToMarkdownText } from "../src/html-text.ts"

describe("htmlToMarkdownText", () => {
  it("writes the Markdown text of an HTML email and unwraps layout tags", async () => {
    const html = [
      "<html><head><title>Hi</title><style>p { color: red }</style></head><body>",
      "<div style=\"padding: 8px\"><table role=\"presentation\"><tr><td>",
      "<h1>Welcome Ada &amp; Bob</h1>",
      "<p style=\"color: red\">Join the <strong class=\"brand\">Docs</strong> team. It&#39;s   free.</p>",
      "<p><a style=\"color: blue\" href=\"https://example.com/?a=1&amp;b=2\">Open it</a></p>",
      "<ul><li>One</li><li>Two</li></ul>",
      "</td></tr><tr><td><div>First cell</div><span>and more</span></td></tr></table></div>",
      "<footer><p>Line one<br>Line two</p></footer>",
      "</body></html>",
    ].join("")

    await expect(htmlToMarkdownText(html)).resolves.toBe([
      "# Welcome Ada & Bob",
      "",
      "Join the **Docs** team. It's free.",
      "",
      "[Open it](https://example.com/?a=1&b=2)",
      "",
      "- One",
      "- Two",
      "",
      "First cell",
      "",
      "and more",
      "",
      "Line one  ",
      "Line two",
    ].join("\n"))
  })

  it("keeps preformatted text as written", async () => {
    await expect(htmlToMarkdownText("<pre><code>a  &lt;b&gt;\n  c</code></pre>")).resolves.toBe("```\na  <b>\n  c\n```")
  })
})
