// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createViteHubPageWindow } from "../src/runtime/page-tools-window.ts"

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe("page tool window", () => {
  it("preserves layout dimensions across restores during the opening scale transition", () => {
    const callbacks: (() => void)[] = []
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { callbacks.push(callback) }
      observe() {}
      disconnect() {}
    })
    for (let load = 0; load < 2; load++) {
      const window = createViteHubPageWindow({ id: "content", title: "Content", trigger: document.createElement("button"), signal: new AbortController().signal })
      const panel = window.body.closest<HTMLElement>(".window")!
      vi.spyOn(panel, "offsetWidth", "get").mockReturnValue(600)
      vi.spyOn(panel, "offsetHeight", "get").mockReturnValue(640)
      vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 576, 614.4))
      if (load > 0) expect([panel.style.width, panel.style.height]).toEqual(["600px", "640px"])
      window.show()
      callbacks[load]!()
      expect(JSON.parse(localStorage.getItem("vitehub-window:content")!)).toEqual({ width: 600, height: 640 })
      window.destroy()
    }
  })

  it.each([false, true])("keeps the same editor and draft through expansion, minimization and reopening (Trusted Types: %s)", (trustedTypes) => {
    if (trustedTypes) vi.spyOn(ShadowRoot.prototype, "innerHTML", "set").mockImplementation(() => {
      throw new TypeError("This document requires 'TrustedHTML' assignment.")
    })
    const trigger = document.createElement("button")
    document.body.append(trigger)
    const controller = new AbortController()
    const window = createViteHubPageWindow({ id: "content", title: "Content", trigger, signal: controller.signal })
    const input = document.createElement("textarea")
    window.body.append(input)
    window.show()
    input.value = "A draft that has not saved"
    const host = document.querySelector<HTMLElement>("vitehub-window")!
    expect(host.shadowRoot!.querySelector("[role=dialog]")!.getAttribute("aria-labelledby")).toBe("title")
    expect(host.shadowRoot!.querySelector("#title")!.textContent).toBe("Content")
    expect([...host.shadowRoot!.querySelectorAll("svg")].map(svg => svg.namespaceURI)).toEqual(["http://www.w3.org/2000/svg", "http://www.w3.org/2000/svg"])
    host.shadowRoot!.querySelector<HTMLButtonElement>(".expand")!.click()
    expect(host.shadowRoot!.querySelector(".expanded")).not.toBeNull()
    host.shadowRoot!.querySelector<HTMLButtonElement>(".hide")!.click()
    expect(host.hidden).toBe(true)
    expect(document.activeElement).toBe(trigger)
    window.show()
    expect(window.body.firstChild).toBe(input)
    expect(input.value).toBe("A draft that has not saved")
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }))
    expect(host.hidden).toBe(true)
    expect(document.activeElement).toBe(trigger)
    controller.abort()
    expect(document.querySelector("vitehub-window")).toBeNull()
  })

  it("moves focus to the window itself and takes the content's color scheme", () => {
    const trigger = document.createElement("button")
    document.body.append(trigger)
    let scheme: "light" | "dark" | undefined = "dark"
    const window = createViteHubPageWindow({ id: "content", title: "Content", trigger, signal: new AbortController().signal, colorScheme: () => scheme })
    window.show()
    const host = document.querySelector<HTMLElement>("vitehub-window")!
    expect(host.shadowRoot!.activeElement).toBe(host.shadowRoot!.querySelector("[role=dialog]"))
    expect(host.style.colorScheme).toBe("dark")
    scheme = undefined
    dispatchEvent(new StorageEvent("storage", { key: "vitehub-console:appearance" }))
    expect(host.style.colorScheme).toBe("")
  })
})
