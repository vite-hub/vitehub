// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createViteHubPageWindow, dockViteHubPageWindows } from "../src/runtime/page-tools-window.ts"

afterEach(() => {
  dockViteHubPageWindows({ edge: "bottom", at: 50 })
  for (const host of document.querySelectorAll("vitehub-window")) host.remove()
  document.body.replaceChildren()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("page tool window", () => {
  it.each([
    ["bottom", "left", 0], ["top", "right", 100],
    ["left", "top", 0], ["right", "bottom", 100],
  ] as const)("hides the immovable %s-docked %s grip at %s%%", (edge, side, at) => {
    dockViteHubPageWindows({ edge, at })
    const window = createViteHubPageWindow({ id: "content", title: "Content", trigger: document.createElement("button"), signal: new AbortController().signal })
    const grip = window.body.closest(".window")!.querySelector<HTMLElement>(`.grip.${side}`)!
    expect(grip.hidden).toBe(true)
    dockViteHubPageWindows({ edge, at: 50 })
    expect(grip.hidden).toBe(false)
    window.destroy()
  })

  it.each([
    ["bottom", "left", 20, -10, 650],
    ["top", "right", 80, 10, 650],
    ["left", "top", 20, -10, 450],
    ["right", "bottom", 80, 10, 450],
  ] as const)("keeps the %s-docked %s grip under the pointer at %s%%", (edge, side, at, delta, expected) => {
    dockViteHubPageWindows({ edge, at })
    const window = createViteHubPageWindow({ id: "content", title: "Content", trigger: document.createElement("button"), signal: new AbortController().signal })
    const panel = window.body.closest<HTMLElement>(".window")!
    vi.spyOn(panel, "offsetWidth", "get").mockReturnValue(600)
    vi.spyOn(panel, "offsetHeight", "get").mockReturnValue(400)
    const grip = panel.querySelector<HTMLElement>(`.grip.${side}`)!
    grip.setPointerCapture = () => {}
    grip.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 200, clientY: 200, pointerId: 1 }))
    grip.dispatchEvent(new PointerEvent("pointermove", { clientX: 200 + delta, clientY: 200 + delta, pointerId: 1 }))
    grip.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 1 }))
    expect(side === "left" || side === "right" ? panel.style.width : panel.style.height).toBe(`${expected}px`)
    window.destroy()
  })

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

  it("opens from the edge where the pill docks, follows it, and grows from the side away from the pill", () => {
    const signal = new AbortController().signal
    const first = createViteHubPageWindow({ id: "content", title: "Content", trigger: document.createElement("button"), signal })
    dockViteHubPageWindows({ edge: "right", at: 0, thickness: 120 })
    const second = createViteHubPageWindow({ id: "console", title: "Console", trigger: document.createElement("button"), signal })
    const hosts = [...document.querySelectorAll<HTMLElement>("vitehub-window")]
    for (const host of hosts) expect([host.getAttribute("edge"), host.style.getPropertyValue("--at"), host.style.getPropertyValue("--thickness")]).toEqual(["right", "0", "120px"])
    expect(new Set(hosts.map(host => host.style.viewTransitionName)).size).toBe(2)
    const panel = second.body.closest<HTMLElement>(".window")!
    vi.spyOn(panel, "offsetWidth", "get").mockReturnValue(600)
    vi.spyOn(panel, "offsetHeight", "get").mockReturnValue(400)
    const drag = (side: string, from: [number, number], to: [number, number]) => {
      const grip = panel.querySelector<HTMLElement>(`.grip.${side}`)!
      grip.setPointerCapture = () => {}
      grip.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: from[0], clientY: from[1], pointerId: 1 }))
      grip.dispatchEvent(new PointerEvent("pointermove", { clientX: to[0], clientY: to[1], pointerId: 1 }))
      grip.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 1 }))
    }
    // Docked right, the left grip is the far one; at the top end, the bottom grip moves only the bottom side.
    drag("left", [500, 300], [450, 300])
    expect(panel.style.width).toBe("650px")
    drag("bottom", [500, 700], [500, 760])
    expect(panel.style.height).toBe("460px")
    first.destroy()
    second.destroy()
    expect(document.querySelector("vitehub-window")).toBeNull()
  })
})
