import linkify from "comark/plugins/linkify"
import { afterEach, expect, it, vi } from "vitest"

import { renderMarkdownTemplate } from "../src/index.ts"

afterEach(() => {
  vi.restoreAllMocks()
})

it("keeps plain URLs as text without Comark deprecation warnings", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  await expect(renderMarkdownTemplate("Try https://example.com and {{ data.name }}", { data: { name: "Ada" } }))
    .resolves.toBe("Try https://example.com and Ada")
  await expect(renderMarkdownTemplate("> [!NOTE]\n> Visit https://example.com\n\n- [x] Done"))
    .resolves.toBe("> [!NOTE]\n> Visit https://example.com\n\n- [x] Done")
  await expect(renderMarkdownTemplate(":insert{:markdown=\"data.body\"}", { data: { body: "See https://example.org" } }))
    .resolves.toBe("See https://example.org")
  expect(warn).not.toHaveBeenCalled()
})

it("autolinks URLs when the caller adds the linkify plugin", async () => {
  await expect(renderMarkdownTemplate("Try https://example.com", { plugins: [linkify()] }))
    .resolves.toBe("Try <https://example.com>")
})
