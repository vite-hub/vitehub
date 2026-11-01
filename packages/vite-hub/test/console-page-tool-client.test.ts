// @vitest-environment happy-dom
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

import { loadViteHubPageTools } from "@vite-hub/internal/runtime/page-tools-loader"
import { afterEach, expect, it, vi } from "vitest"
import { createMemoryHistory, createRouter, isNavigationFailure } from "vue-router"

import start from "../src/console/page/tool.ts"

it("remembers only the document actually opened when a leave guard cancels navigation", async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/content/:collection/:id", component: {} }],
  })
  const postMessage = vi.fn()
  const client = readFileSync(`${import.meta.dirname}/../src/console/runtime/client/main.js`, "utf8")
  const embed = client.slice(client.indexOf("// Only the same-origin parent"))
  runInNewContext(embed, {
    router,
    window: { parent: { postMessage }, addEventListener: vi.fn() },
    location: { origin: "http://site.test" },
  })

  await router.push("/content/pages/first?embed=1")
  expect(postMessage).toHaveBeenCalledWith({ type: "vitehub:route", path: "/content/pages/first?embed=1" }, "http://site.test")
  const removeGuard = router.beforeEach(() => false)
  postMessage.mockClear()
  const failure = await router.push("/content/pages/second?embed=1")
  expect(isNavigationFailure(failure)).toBe(true)
  expect(router.currentRoute.value.fullPath).toBe("/content/pages/first?embed=1")
  expect(postMessage.mock.calls.filter(([message]) => message.type === "vitehub:route")).toEqual([])

  removeGuard()
  await router.push("/content/pages/second?embed=1")
  expect(postMessage).toHaveBeenCalledWith({ type: "vitehub:route", path: "/content/pages/second?embed=1" }, "http://site.test")
})

afterEach(() => {
  document.querySelector("vitehub-pill")?.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Turn off ViteHub tools"]')?.click()
  history.replaceState(null, "", "/")
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it.each([false, true])("keeps Content field selection styles through head and body swaps (selecting: %s)", async (selecting) => {
  history.replaceState(null, "", "/?vitehub=content")
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ tools: [
    { id: "content", label: "Content", script: "/_vitehub/assets/page-tool.js" },
  ] })))
  await loadViteHubPageTools({ load: async () => ({ default: start }) })
  const select = document.querySelector("vitehub-tool")!.shadowRoot!.querySelectorAll("button")[1]!
  if (selecting) select.click()
  const style = [...document.head.querySelectorAll("style")].find(element => element.textContent?.includes(".vitehub-select-content"))!
  const before = document.body
  const head = document.head
  const next = document.createElement("body")
  const nextHead = document.createElement("head")
  next.innerHTML = '<h1 data-content-field="pages:next#title">Next page</h1>'
  try {
    document.documentElement.className = "next-page"
    head.replaceWith(nextHead)
    before.replaceWith(next)
    await vi.waitFor(() => {
      expect(style.parentElement).toBe(nextHead)
      expect(document.documentElement.classList.contains("vitehub-select-content")).toBe(selecting)
    })
    expect(document.documentElement.classList.contains("next-page")).toBe(true)
    // Turbo can remove a head stylesheet while retaining the head itself.
    style.remove()
    await vi.waitFor(() => expect(style.parentElement).toBe(nextHead))
    if (!selecting) select.click()
    expect(document.documentElement.classList.contains("vitehub-select-content")).toBe(true)
    document.querySelector("vitehub-pill")!.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Turn off ViteHub tools"]')!.click()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(style.isConnected).toBe(false)
    expect(document.documentElement.classList.contains("vitehub-select-content")).toBe(false)
  }
  finally {
    next.replaceWith(before)
    nextHead.replaceWith(head)
    document.documentElement.className = ""
  }
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

it("moves the Content window out of the way while a field is selected, and brings it back on a cancel", async () => {
  history.replaceState(null, "", "/?vitehub=content")
  document.body.insertAdjacentHTML("beforeend", `<h1 data-content-field="pages:travel#title">Flying</h1><a href="#elsewhere">Elsewhere</a>`)
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ tools: [
    { id: "content", label: "Content", icon: "i-lucide-file-pen", script: "/_vitehub/assets/page-tool.js" },
  ] })))
  await loadViteHubPageTools({ load: async () => ({ default: start }) })
  const [content, select] = [...document.querySelector("vitehub-tool")!.shadowRoot!.querySelectorAll("button")]
  const pageWindow = document.querySelector<HTMLElement>("vitehub-window")!
  const state = () => [pageWindow.hidden, select!.getAttribute("aria-pressed"), document.documentElement.classList.contains("vitehub-select-content")]
  const escape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  try {
    expect([content!.textContent, select!.textContent]).toEqual(["Content", "Select field"])
    expect(pageWindow.hidden).toBe(false)

    // Open window: selecting minimizes it, and Esc, a second click, or a click outside a field restores it.
    select!.click()
    expect(state()).toEqual([true, "true", true])
    escape()
    expect(state()).toEqual([false, "false", false])
    select!.click()
    select!.click()
    expect(state()).toEqual([false, "false", false])
    select!.click()
    const link = document.querySelector("a")!
    const click = new MouseEvent("click", { bubbles: true, cancelable: true })
    link.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(state()).toEqual([false, "false", false])

    // A picked field opens in the restored window.
    select!.click()
    document.querySelector("h1")!.click()
    expect(state()).toEqual([false, "false", false])

    // Minimized window: it stays minimized while selecting and after a cancel, and only a picked field opens it.
    pageWindow.shadowRoot!.querySelector<HTMLButtonElement>(".hide")!.click()
    select!.click()
    expect(state()).toEqual([true, "true", true])
    escape()
    expect(state()).toEqual([true, "false", false])
    select!.click()
    document.querySelector("h1")!.click()
    expect(state()).toEqual([false, "false", false])
  }
  finally { for (const element of document.querySelectorAll("h1, a")) element.remove() }
})
