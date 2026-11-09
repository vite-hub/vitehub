// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"

import { mountViteHubPageLinks } from "../src/runtime/page-links.ts"

import type { ViteHubPageLinkGroup, ViteHubPageLinksOptions } from "../src/runtime/page-links.ts"

const GROUPS: ViteHubPageLinkGroup[] = [
  [
    { url: "https://drop.test/review/open#doc=1", label: "Before/after: pricing", detail: "Drop", icons: ["https://drop.test/favicon.ico"] },
    { url: "https://github.com/acme/app/pull/12", label: "PR #12", detail: "github.com" },
    { url: "https://linear.app/acme/issue/ACM-7", label: "linear.app" },
  ],
  [{ url: "https://drop.test/review/open#doc=2", label: "Pricing plan", detail: "Drop" }],
]

/** The links in a shadow root, as a tool on someone's page keeps them. */
function mount(options: Partial<ViteHubPageLinksOptions> = {}) {
  const controller = new AbortController()
  const resolve = vi.fn(async () => GROUPS)
  const host = document.createElement("div")
  document.body.append(host)
  const root = host.attachShadow({ mode: "open" })
  const links = mountViteHubPageLinks({ slot: "links", resolve, signal: controller.signal, ...options })
  root.append(links.segment, links.menu)
  links.show(true)
  const button = links.segment.querySelector("button")!
  return { links, root, button, resolve, controller }
}

const rows = (menu: HTMLElement) => [...menu.querySelectorAll("ul")].map(list => [...list.querySelectorAll("a")].map(a => [a.querySelector(".vitehub-links-name")?.textContent, a.getAttribute("href"), a.querySelector(".vitehub-links-detail")?.textContent ?? ""]))

afterEach(() => {
  document.body.replaceChildren()
})

describe("mountViteHubPageLinks", () => {
  it("resolves the links on the first press, lists each group, and keeps them until forget()", async () => {
    const { links, root, button, resolve } = mount()
    expect(button.textContent).toBe("Related links")
    expect(links.menu.hidden).toBe(true)

    button.click()
    // The resolver runs in the press, before any await, so it can still open a popup.
    expect(resolve).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(links.isOpen()).toBe(true))
    expect(button.getAttribute("aria-expanded")).toBe("true")
    expect(links.menu.querySelector("p")?.textContent).toBe("Related links")
    expect(rows(links.menu)).toEqual([
      [
        ["Before/after: pricing", "https://drop.test/review/open#doc=1", "Drop"],
        ["PR #12", "https://github.com/acme/app/pull/12", "github.com"],
        ["linear.app", "https://linear.app/acme/issue/ACM-7", ""],
      ],
      [["Pricing plan", "https://drop.test/review/open#doc=2", "Drop"]],
    ])
    const anchors = [...links.menu.querySelectorAll("a")]
    expect(anchors.every(a => a.target === "_blank" && a.rel === "noopener noreferrer")).toBe(true)
    expect(root.activeElement).toBe(anchors[0])
    // GitHub gets its mark, a link with icons tries them with no referrer, one without gets a link icon.
    expect(anchors[1]!.querySelector("svg.vitehub-links-github")).not.toBeNull()
    expect(anchors[0]!.querySelector("img")?.referrerPolicy).toBe("no-referrer")
    expect(anchors[2]!.querySelector("img")).toBeNull()

    button.click()
    expect(links.isOpen()).toBe(false)
    button.click()
    await vi.waitFor(() => expect(links.isOpen()).toBe(true))
    expect(resolve).toHaveBeenCalledOnce()

    links.forget()
    expect(links.isOpen()).toBe(false)
    button.click()
    await vi.waitFor(() => expect(links.isOpen()).toBe(true))
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it("says so when nothing is found, shows the resolver's error, and closes on an error without a message", async () => {
    const empty = mount({ resolve: async () => [[]], empty: "Nothing here is shared with you." })
    empty.button.click()
    await vi.waitFor(() => expect(empty.links.isOpen()).toBe(true))
    expect(empty.links.menu.querySelector("[role=status]")?.textContent).toBe("Nothing here is shared with you.")

    let fail = new Error("Couldn't reach Drop.")
    const failing = mount({ resolve: async () => { throw fail } })
    failing.button.click()
    await vi.waitFor(() => expect(failing.links.isOpen()).toBe(true))
    expect(failing.links.menu.querySelector("[role=status]")?.textContent).toBe("Couldn't reach Drop.")
    failing.links.close()
    // A failure is not kept: the next press asks again. A cancelled sign-in has no message, so the menu stays shut.
    fail = new Error("")
    failing.button.click()
    await vi.waitFor(() => expect(failing.button.hasAttribute("aria-busy")).toBe(false))
    expect(failing.links.isOpen()).toBe(false)
  })

  it("closes on Esc, on a press outside it, on a press elsewhere in its root, and when a link opens", async () => {
    const onOpen = vi.fn()
    const { links, root, button } = mount({ onOpen })
    const other = document.createElement("button")
    root.append(other)
    const open = async () => {
      button.click()
      await vi.waitFor(() => expect(links.isOpen()).toBe(true))
    }

    await open()
    expect(onOpen).toHaveBeenCalledOnce()
    links.menu.querySelector("a")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }))
    expect(links.isOpen()).toBe(false)
    expect(root.activeElement).toBe(button)

    await open()
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }))
    expect(links.isOpen()).toBe(false)

    await open()
    links.menu.querySelector("a")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }))
    expect(links.isOpen()).toBe(true)
    other.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }))
    expect(links.isOpen()).toBe(false)

    await open()
    links.menu.querySelector("a")!.addEventListener("click", event => event.preventDefault())
    links.menu.querySelector("a")!.click()
    expect(links.isOpen()).toBe(false)
  })

  it("starts hidden, closes when hidden, docks beside the pill, and goes away on abort", async () => {
    const { links, button, controller } = mount()
    links.show(false)
    expect(links.segment.hidden).toBe(true)
    links.show(true)
    button.click()
    await vi.waitFor(() => expect(links.isOpen()).toBe(true))
    links.show(false)
    expect(links.isOpen()).toBe(false)

    links.place({ edge: "bottom", at: 50, collapsed: false, thickness: 40 })
    expect([links.menu.style.bottom, links.menu.style.left, links.menu.style.translate]).toEqual(["64px", "50%", "-50% 0"])
    links.place({ edge: "right", at: 100, collapsed: true, thickness: 24 })
    expect([links.menu.style.right, links.menu.style.bottom, links.menu.style.left]).toEqual(["34px", "16px", ""])

    controller.abort()
    expect(links.segment.isConnected).toBe(false)
    expect(links.menu.isConnected).toBe(false)
  })
})
