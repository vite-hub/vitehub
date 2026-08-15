import { describe, expect, it } from "vitest"
import { parseFragment } from "parse5"

import { renderEmailMarkdown } from "../src/markdown.ts"

describe("renderEmailMarkdown", () => {
  it("composes Dynamic Markdown into HTML and a portable text fallback", async () => {
    const rendered = await renderEmailMarkdown([
      "# Hello {{ customer.name }}",
      "",
      "Welcome to **ViteHub**.",
      "",
      "::if{customer.trial}",
      "Your trial is active.",
      "::",
    ].join("\n"), {
      data: { customer: { name: "Maxi", trial: true } },
    })

    expect(rendered).toEqual({
      html: "<h1 id=\"hello-maxi\">Hello Maxi</h1>\n<p>Welcome to <strong>ViteHub</strong>.</p>\n<p>Your trial is active.</p>",
      text: "# Hello Maxi\n\nWelcome to **ViteHub**.\n\nYour trial is active.",
    })
  })

  it("forwards template import resolution", async () => {
    await expect(renderEmailMarkdown("Hello\n\n@./footer.md", {
      resolveImport: async () => ({ id: "/footer.md", template: "Regards, **ViteHub**" }),
      sourceId: "/welcome.md",
    })).resolves.toEqual({
      html: "<p>Hello</p>\n<p>Regards, <strong>ViteHub</strong></p>",
      text: "Hello\n\nRegards, **ViteHub**",
    })
  })

  it("renders a scalar Markdown link destination as one anchor", async () => {
    await expect(renderEmailMarkdown("[Open and share your visual recap]({{ url }})", {
      data: { url: "https://prs.onmax.me/recap/2026-07" },
    })).resolves.toEqual({
      html: "<p><a href=\"https://prs.onmax.me/recap/2026-07\">Open and share your visual recap</a></p>",
      text: "[Open and share your visual recap](https://prs.onmax.me/recap/2026-07)",
    })
  })

  it("keeps character references inside a scalar link destination", async () => {
    const url = "https://example.com/?x=&#x29;*Injected*"
    const rendered = await renderEmailMarkdown("[Open recap]({{ url }})", { data: { url } })
    expect(rendered).toEqual({
      html: "<p><a href=\"https://example.com/?x=&#x%329;*Injected*\">Open recap</a></p>",
      text: "[Open recap](https://example.com/?x=&#x%329;*Injected*)",
    })

    const paragraph = parseFragment(rendered.html).childNodes[0]!
    expect("childNodes" in paragraph).toBe(true)
    if (!("childNodes" in paragraph)) return
    const anchor = paragraph.childNodes[0]!
    expect("attrs" in anchor).toBe(true)
    if (!("attrs" in anchor)) return
    const parsedUrl = new URL(anchor.attrs.find(attribute => attribute.name === "href")!.value)
    const sourceUrl = new URL(url)
    expect(parsedUrl.search).toBe(sourceUrl.search)
    expect(decodeURIComponent(parsedUrl.hash)).toBe(sourceUrl.hash)
  })
})
