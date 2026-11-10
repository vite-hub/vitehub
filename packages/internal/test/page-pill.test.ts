// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"

import { closeViteHubPagePill, mountViteHubPagePill, readViteHubPageDock, viteHubPageSvgIcon } from "../src/runtime/page-pill.ts"

import type { ViteHubPagePillOptions, ViteHubPagePillPlace } from "../src/runtime/page-pill.ts"

const storage = { collapsed: "review-collapsed", dock: "review-dock" }

function mount(options: Partial<ViteHubPagePillOptions> = {}) {
  const controller = new AbortController()
  const places: ViteHubPagePillPlace[] = []
  const element = mountViteHubPagePill({
    name: "review-pill",
    label: "review tools",
    mark: viteHubPageSvgIcon("0 0 20 18", "M0 0h20v18H0z", {}),
    slots: ["review"],
    storage,
    onPlace: place => places.push(place),
    signal: controller.signal,
    ...options,
  })
  const mark = element.shadowRoot!.querySelector<HTMLButtonElement>("button.mark")!
  return { element, mark, places, controller }
}

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  document.documentElement.replaceChildren(document.createElement("head"), document.createElement("body"))
})

describe("mountViteHubPagePill", () => {
  it("does not mount or observe when its signal is already aborted", () => {
    const controller = new AbortController()
    controller.abort()
    const observe = vi.spyOn(ResizeObserver.prototype, "observe")
    const onPlace = vi.fn()
    const { element } = mount({ signal: controller.signal, onPlace })
    expect(element.isConnected).toBe(false)
    expect(observe).not.toHaveBeenCalled()
    expect(onPlace).not.toHaveBeenCalled()
  })

  it("removes the pill and disconnects its observer on abort", () => {
    const disconnect = vi.spyOn(ResizeObserver.prototype, "disconnect")
    const { element, controller } = mount()
    expect(element.isConnected).toBe(true)
    controller.abort()
    expect(element.isConnected).toBe(false)
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it("cleans up when initial placement aborts the owner", () => {
    const controller = new AbortController()
    const observe = vi.spyOn(ResizeObserver.prototype, "observe")
    const disconnect = vi.spyOn(ResizeObserver.prototype, "disconnect")
    const watch = vi.fn()
    const { element } = mount({
      signal: controller.signal,
      onPlace: () => controller.abort(),
      markOnly: { active: () => false, watch },
    })
    expect(element.isConnected).toBe(false)
    expect(observe).not.toHaveBeenCalled()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(watch).not.toHaveBeenCalled()
  })

  it("draws a pill of its own name in the given parent, with its slots and no exit button", () => {
    const parent = document.createElement("div")
    document.body.append(parent)
    const { element, mark } = mount({ parent, slots: ["review", "highlight"] })
    expect(element.localName).toBe("review-pill")
    expect(element.parentNode).toBe(parent)
    expect(element.style.viewTransitionName).toBe("review-pill")
    const toolbar = element.shadowRoot!.querySelector("[role=toolbar]")!
    expect(toolbar.getAttribute("aria-label")).toBe("review tools")
    expect([...toolbar.querySelectorAll("slot")].map(slot => slot.name)).toEqual(["review", "highlight"])
    expect(toolbar.querySelector(".exit")).toBeNull()
    expect([mark.getAttribute("aria-label"), mark.title]).toEqual(["Hide review tools", "Hide review tools. Drag to move."])
  })

  it("starts where the caller says until the browser keeps a place, then the browser wins", () => {
    const first = mount({ initial: { dock: { edge: "left", at: 0 }, collapsed: true } })
    expect([first.element.getAttribute("edge"), first.element.style.getPropertyValue("--at")]).toEqual(["left", "0"])
    expect(first.element.hasAttribute("collapsed")).toBe(true)
    expect(first.places.at(-1)).toMatchObject({ edge: "left", at: 0, collapsed: true })
    first.mark.click()
    // Open differs from the initial state, so the browser keeps it, even when the initial state is collapsed.
    expect(localStorage.getItem(storage.collapsed)).toBe("0")
    first.controller.abort()
    expect(first.element.isConnected).toBe(false)

    localStorage.setItem(storage.dock, JSON.stringify({ edge: "top", at: 30 }))
    const second = mount({ initial: { dock: { edge: "left", at: 0 }, collapsed: true } })
    expect([second.element.getAttribute("edge"), second.element.style.getPropertyValue("--at")]).toEqual(["top", "30"])
    expect(second.element.hasAttribute("collapsed")).toBe(false)
    second.mark.click()
    expect(localStorage.getItem(storage.collapsed)).toBeNull()
  })

  it("adds the exit button after the slots when asked", () => {
    const pressed: boolean[] = []
    const { element } = mount({ exit: { label: "Close review", press: keyboard => pressed.push(keyboard) } })
    const exit = element.shadowRoot!.querySelector<HTMLButtonElement>("button.exit")!
    expect(exit.previousElementSibling?.localName).toBe("slot")
    expect(exit.getAttribute("aria-label")).toBe("Close review")
    exit.click()
    expect(pressed).toEqual([true])
  })
})

describe("pill folds", () => {
  it("folds to the hexagon by default, or to the bare mark when asked", () => {
    expect(mount().element.hasAttribute("fold")).toBe(false)
    document.documentElement.replaceChildren(document.createElement("head"), document.createElement("body"))
    expect(mount({ fold: "mark" }).element.getAttribute("fold")).toBe("mark")
  })

  it("closes into its collapsed shape without keeping that as the browser's choice", async () => {
    const { element, mark } = mount()
    await closeViteHubPagePill(element)
    expect(element.hasAttribute("collapsed")).toBe(true)
    expect(element.inert).toBe(true)
    expect(mark.getAttribute("aria-expanded")).toBe("true")
    expect(localStorage.getItem(storage.collapsed)).toBeNull()
  })
})

describe("readViteHubPageDock", () => {
  it.each([
    [{ edge: "right", at: 20 }, { edge: "right", at: 20 }],
    [{ edge: "middle", at: 20 }, undefined],
    [{ edge: "top", at: 101 }, undefined],
    [{ edge: "top", at: Number.NaN }, undefined],
    [null, undefined],
  ])("reads %j", (value, dock) => {
    expect(readViteHubPageDock(value)).toEqual(dock)
  })
})
