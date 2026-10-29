// @vitest-environment happy-dom
import { loadViteHubPageTools } from "@vite-hub/internal/runtime/page-tools-loader"
import { afterEach, expect, it, vi } from "vitest"

import start from "../src/console/page/tool.ts"

afterEach(() => {
  document.querySelector("vitehub-pill")?.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Turn off ViteHub tools"]')?.click()
  history.replaceState(null, "", "/")
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it("opens and minimizes the retained Console window when Trusted Types blocks HTML sinks", async () => {
  vi.spyOn(ShadowRoot.prototype, "innerHTML", "set").mockImplementation(() => {
    throw new TypeError("This document requires 'TrustedHTML' assignment.")
  })
  history.replaceState(null, "", "/?vitehub")
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ tools: [
    { id: "console", label: "Console", icon: "i-lucide-square-terminal", script: "/_vitehub/assets/page-tool.js" },
  ] })))
  await loadViteHubPageTools({ load: async () => ({ default: start }) })

  const bar = document.querySelector("vitehub-tool")!
  const button = bar.shadowRoot!.querySelector("button")!
  expect(button.textContent).toBe("Console")
  expect(button.getAttribute("aria-haspopup")).toBe("dialog")
  const pageWindow = document.querySelector<HTMLElement>("vitehub-window")!
  expect(pageWindow.hidden).toBe(true)
  button.click()
  expect(pageWindow.hidden).toBe(false)
  expect(button.getAttribute("aria-expanded")).toBe("true")
  const frame = pageWindow.shadowRoot!.querySelector("iframe")!
  expect(frame.title).toBe("Console editor")
  expect(new URL(frame.src).searchParams.get("embed")).toBe("1")
  expect(pageWindow.shadowRoot!.querySelector("svg")?.namespaceURI).toBe("http://www.w3.org/2000/svg")
  pageWindow.shadowRoot!.querySelector<HTMLButtonElement>(".hide")!.click()
  expect(pageWindow.hidden).toBe(true)
  button.click()
  expect(pageWindow.shadowRoot!.querySelector("iframe")).toBe(frame)
})
