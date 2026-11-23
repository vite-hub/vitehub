import { describe, expect, it } from "vitest"
import { renderEmailMarkdown } from "../src/markdown.ts"

describe("renderEmailMarkdown", () => {
  it("composes Dynamic Markdown into HTML and a portable text fallback", async () => {
    const rendered = await renderEmailMarkdown([
      "# Hello {{ data.customer.name }}",
      "",
      "Welcome to **ViteHub**.",
      "",
      "::if{:condition=\"data.customer.trial\"}",
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

  it("renders explicitly supplied Markdown fragments", async () => {
    await expect(renderEmailMarkdown("Hello\n\n:insert{:markdown=\"data.footer\"}", {
      data: { footer: "Regards, **ViteHub**" },
    })).resolves.toEqual({
      html: "<p>Hello</p>\n<p>Regards, <strong>ViteHub</strong></p>",
      text: "Hello\n\nRegards, **ViteHub**",
    })
  })

  it("renders a scalar Markdown link destination as one anchor", async () => {
    await expect(renderEmailMarkdown("[Open and share your visual recap](){:href=\"data.url\"}", {
      data: { url: "https://prs.onmax.me/recap/2026-07" },
    })).resolves.toEqual({
      html: "<p><a href=\"https://prs.onmax.me/recap/2026-07\">Open and share your visual recap</a></p>",
      text: "[Open and share your visual recap](https://prs.onmax.me/recap/2026-07)",
    })
  })

  it("rejects a binding used as the link destination", async () => {
    await expect(renderEmailMarkdown("[Open and share your visual recap]({{ data.url }})", {
      data: { url: "https://prs.onmax.me/recap/2026-09" },
    })).rejects.toThrow("Use [label](){:href=\"data.url\"}.")
  })

  it("rejects a scalar link destination whose meaning would change", async () => {
    await expect(renderEmailMarkdown("[Open recap](){:href=\"data.url\"}", {
      data: { url: "https://example.com/?x=&#x29;*Injected*" },
    })).rejects.toThrow("must resolve to a safe destination")
  })

  it("preserves backslash data in a scalar link query", async () => {
    await expect(renderEmailMarkdown("[Open recap](){:href=\"data.url\"}", {
      data: { url: "https://example.com/?q=a\\b" },
    })).resolves.toEqual({
      html: "<p><a href=\"https://example.com/?q=a%5Cb\">Open recap</a></p>",
      text: "[Open recap](https://example.com/?q=a%5Cb)",
    })
  })

  it("preserves backslash data in an opaque scalar destination", async () => {
    await expect(renderEmailMarkdown("[Open item](){:href=\"data.url\"}", {
      data: { url: "web+demo:folder\\item" },
    })).resolves.toEqual({
      html: "<p><a href=\"web+demo:folder%5Citem\">Open item</a></p>",
      text: "[Open item](web+demo:folder%5Citem)",
    })

    await expect(renderEmailMarkdown("[Open item](){:href=\"data.url\"}", {
      data: { url: "web+demo:\\folder\\item" },
    })).resolves.toEqual({
      html: "<p><a href=\"web+demo:%5Cfolder%5Citem\">Open item</a></p>",
      text: "[Open item](web+demo:%5Cfolder%5Citem)",
    })

    await expect(renderEmailMarkdown("[Open item](){:href=\"data.url\"}", {
      data: { url: "web+demo:/folder\\item" },
    })).resolves.toEqual({
      html: "<p><a href=\"web+demo:/folder%5Citem\">Open item</a></p>",
      text: "[Open item](web+demo:/folder%5Citem)",
    })

    await expect(renderEmailMarkdown("[Open item](){:href=\"data.url\"}", {
      data: { url: "web+demo://host/folder\\item" },
    })).resolves.toEqual({
      html: "<p><a href=\"web+demo://host/folder%5Citem\">Open item</a></p>",
      text: "[Open item](web+demo://host/folder%5Citem)",
    })
  })

  it("fills the subject frontmatter as plain text and leaves it out of the body", async () => {
    await expect(renderEmailMarkdown("---\nsubject: Your *recap* for {{ data.month }}\n---\n\nHello {{ data.month }}", {
      data: { month: "{{ data.secret }}", secret: "leak" },
    })).resolves.toEqual({
      subject: "Your *recap* for {{ data.secret }}",
      html: "<p>Hello {{ data.secret }}</p>",
      text: "Hello {{ data.secret }}",
    })
  })

  it("rejects frontmatter other than a string subject", async () => {
    await expect(renderEmailMarkdown("---\ntitle: Hi\n---\n\nHello")).rejects.toMatchObject({ code: "EMAIL_TEMPLATE_FRONTMATTER_INVALID" })
    await expect(renderEmailMarkdown("---\nsubject: [Hi]\n---\n\nHello")).rejects.toMatchObject({ code: "EMAIL_TEMPLATE_FRONTMATTER_INVALID" })
  })
})
