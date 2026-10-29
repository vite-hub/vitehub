// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest"

import start from "../src/console/page/tool.ts"

afterEach(() => {
  vi.restoreAllMocks()
})

it("renders the Console link when Trusted Types blocks HTML sinks", () => {
  vi.spyOn(ShadowRoot.prototype, "innerHTML", "set").mockImplementation(() => {
    throw new TypeError("This document requires 'TrustedHTML' assignment.")
  })
  const bar = document.createElement("vitehub-tool")
  start({
    bar,
    tool: { id: "console", label: "Console", icon: "i-lucide-square-terminal", script: "/_vitehub/assets/page-tool.js" },
    signal: new AbortController().signal,
    open: false,
    exit: vi.fn(),
  })

  const link = bar.shadowRoot!.querySelector("a")!
  expect(link.textContent).toBe("Console")
  expect(link.target).toBe("_blank")
  expect(link.rel).toBe("noopener")
  expect(link.title).toBe("Open the Console in a new tab")
  expect(link.hasAttribute("href")).toBe(true)
  expect(link.querySelector("svg")?.namespaceURI).toBe("http://www.w3.org/2000/svg")
})
