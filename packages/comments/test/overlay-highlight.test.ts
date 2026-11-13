// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { api } from "../src/overlay/api.ts"
import { captureMarked } from "../src/overlay/marker.ts"
import { pageTools, press, serveComments, startOverlay, tool, type } from "./overlay-harness.ts"

vi.mock("@vite-hub/realtime/client", () => ({
  connectRealtimeRoom: vi.fn(() => ({ states: () => new Map(), people: () => [], onUpdate: vi.fn(), onChange: vi.fn(), notify: vi.fn(), setLocal: vi.fn(), destroy: vi.fn() })),
}))
// Happy DOM draws no pixels, so the screenshot is a stand-in. The browser test takes a real one.
vi.mock("../src/overlay/marker.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../src/overlay/marker.ts")>(),
  captureMarked: vi.fn(async () => new Blob(["webp bytes"], { type: "image/webp" })),
}))

const ada = { id: "ada", name: "Ada Lovelace" }

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  history.replaceState(null, "", "/pricing")
  document.body.innerHTML = "<main><h1>Pricing</h1><p>Plans</p></main>"
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 200, 40))
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [document.querySelector("h1")!] })
  Object.assign(Element.prototype, { setPointerCapture: () => {} })
})

afterEach(() => {
  for (const element of document.querySelectorAll("vitehub-comments, vitehub-pill, vitehub-marker")) element.remove()
  document.documentElement.className = ""
  Reflect.deleteProperty(document, "elementsFromPoint")
  vi.restoreAllMocks()
})

async function site(user: typeof ada | null = ada) {
  const stored: string[] = []
  const server = await serveComments({ identify: () => user, authorize: () => true, storeAttachment: (file) => {
    stored.push(`${file.name} ${file.type}`)
    return `files/${file.name}`
  } })
  const tools = pageTools()
  const { shadow } = await startOverlay(tools)
  await vi.waitFor(() => expect(tool(tools.bar, "Highlight")).not.toBeNull())
  return { ...server, ...tools, shadow, stored }
}

const layer = () => document.querySelector("vitehub-marker")?.shadowRoot?.querySelector<HTMLElement>(".layer") ?? null
const button = (bar: HTMLElement, label: string) => [...bar.shadowRoot!.querySelectorAll("button")].find(element => element.textContent === label || element.getAttribute("aria-label") === label)

function stroke(points: Array<[number, number]>) {
  const [first, ...rest] = points
  const target = layer()!
  target.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: first![0], clientY: first![1], bubbles: true }))
  for (const [x, y] of rest) target.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }))
  target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
}

describe("Highlight in the Comments segment", () => {
  it("cancels Highlight on navigation and waits for permission on the new page", async () => {
    const { bar } = await site()
    tool(bar, "Highlight")!.click()
    await vi.waitFor(() => expect(layer()).not.toBeNull())
    stroke([[20, 20], [60, 20]])

    let answer!: (value: Awaited<ReturnType<typeof api.session>>) => void
    const pending = new Promise<Awaited<ReturnType<typeof api.session>>>((resolve) => { answer = resolve })
    const session = vi.spyOn(api, "session").mockReturnValueOnce(pending)
    history.pushState(null, "", "/next")
    await vi.waitFor(() => expect(layer()).toBeNull())
    expect(session).toHaveBeenCalledWith("/next")
    tool(bar, "Highlight")!.click()
    press(document.body, "b")
    expect(layer()).toBeNull()

    answer([undefined, { user: ada, can: { read: true, comment: false, resolve: false }, realtime: false, content: false }])
    await vi.waitFor(() => expect(tool(bar, "Highlight")).toBeNull())
    press(document.body, "b")
    expect(layer()).toBeNull()

    history.pushState(null, "", "/allowed")
    await vi.waitFor(() => expect(tool(bar, "Highlight")).not.toBeNull())
    press(document.body, "b")
    await vi.waitFor(() => expect(layer()).not.toBeNull())
  })

  it.each(["button", "B"])("resumes Highlight after a guest gives their name using %s", async (action) => {
    const { bar, shadow } = await site(null)
    if (action === "button") tool(bar, "Highlight")!.click()
    else press(document.body, "b")
    await vi.waitFor(() => expect(shadow.querySelector('input[aria-label="Your name"]')).not.toBeNull())
    expect(layer()).toBeNull()
    const name = shadow.querySelector<HTMLInputElement>('input[aria-label="Your name"]')!
    await type(name, "Ana")
    name.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(layer()).not.toBeNull())
    expect(shadow.querySelector('[data-slot="comment-layer-overlay"]')).toBeNull()
    stroke([[20, 20], [60, 20]])
    expect(layer()!.querySelectorAll("path")).toHaveLength(1)
    await vi.waitFor(() => expect(button(bar, "Done")?.disabled).toBe(false))
  })

  it("comments on the highlighted area with a screenshot of the strokes", async () => {
    const { bar, shadow, comments, stored } = await site()
    tool(bar, "Highlight")!.click()
    await vi.waitFor(() => expect(layer()).not.toBeNull())
    await vi.waitFor(() => expect(button(bar, "Done")?.disabled).toBe(true))
    stroke([[20, 20], [70, 22], [120, 24]])
    await vi.waitFor(() => expect(button(bar, "Done")?.disabled).toBe(false))

    button(bar, "Done")!.click()
    await vi.waitFor(() => expect(shadow.querySelector('[data-slot="comment-layer-popover"] [data-slot="attachment"]')).not.toBeNull())
    expect(vi.mocked(captureMarked).mock.calls[0]![0]).toEqual([{ color: "#facc15", points: [[20, 20], [70, 22], [120, 24]] }])
    // The strokes stay on the page, where they were drawn, while the comment is written. The toolbar is back.
    expect(layer()!.hasAttribute("data-frozen")).toBe(true)
    expect(tool(bar, "Highlight")).not.toBeNull()

    const box = shadow.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')!
    await type(box, "This price is wrong")
    press(box, "Enter")
    await vi.waitFor(async () => expect((await comments.list())[1]).toHaveLength(1))
    const [thread] = (await comments.list())[1]!
    expect(thread!.anchor).toMatchObject({ kind: "area" })
    expect(thread!.messages[0]!.attachments).toEqual(["files/highlight.webp"])
    expect(stored).toEqual(["highlight.webp image/webp"])
    await vi.waitFor(() => expect(document.querySelector("vitehub-marker")).toBeNull())
  })

  it("toggles with B, undoes the last stroke, keeps the page still, and cancels with Esc", async () => {
    const { bar } = await site()
    press(document.body, "b")
    await vi.waitFor(() => expect(layer()).not.toBeNull())
    stroke([[20, 20], [60, 20]])
    stroke([[20, 30], [60, 30]])
    expect(layer()!.querySelectorAll("path")).toHaveLength(2)

    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }))
    expect(layer()!.querySelectorAll("path")).toHaveLength(1)
    await vi.waitFor(() => expect(button(bar, "Undo")?.disabled).toBe(false))
    button(bar, "Undo")!.click()
    expect(layer()!.querySelectorAll("path")).toHaveLength(0)

    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })
    document.body.dispatchEvent(space)
    expect(space.defaultPrevented).toBe(true)
    // C does nothing while highlighting.
    press(document.body, "c")
    expect(document.documentElement.classList.contains("vitehub-comment-mode")).toBe(false)

    press(document.body, "Escape")
    await vi.waitFor(() => expect(layer()).toBeNull())
    expect(tool(bar, "Highlight")).not.toBeNull()
    press(document.body, "b")
    await vi.waitFor(() => expect(layer()).not.toBeNull())
    press(document.body, "b")
    await vi.waitFor(() => expect(layer()).toBeNull())
  })

  it("marks the area without a picture when the page cannot be drawn", async () => {
    vi.mocked(captureMarked).mockResolvedValueOnce(undefined)
    const { bar, shadow } = await site()
    tool(bar, "Highlight")!.click()
    await vi.waitFor(() => expect(layer()).not.toBeNull())
    stroke([[20, 20], [120, 24]])
    await vi.waitFor(() => expect(button(bar, "Done")?.disabled).toBe(false))
    button(bar, "Done")!.click()
    await vi.waitFor(() => expect(shadow.querySelector('textarea[aria-label="Comment"]')).not.toBeNull())
    expect(shadow.querySelector('[data-slot="comment-layer-popover"] [data-slot="attachment"]')).toBeNull()
    expect(shadow.querySelector(".toast")?.textContent).toContain("could not be drawn")
  })
})
