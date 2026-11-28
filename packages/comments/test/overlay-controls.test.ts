// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { commentsButton, openList, pageTools, press, serveComments, startOverlay, tool, wholePage } from "./overlay-harness.ts"

const author = { id: "ada", name: "Ada Lovelace" }

beforeEach(() => {
  history.replaceState(null, "", "/")
})

afterEach(() => {
  document.body.replaceChildren()
  document.querySelector("vitehub-pill")?.remove()
  document.documentElement.className = ""
  localStorage.clear()
  vi.unstubAllGlobals()
})

it.each(["current", "cached"])("hides All comments to compose a page comment with the %s loader", async (loader) => {
  await serveComments({ identify: () => author })
  const tools = pageTools()
  const createWindow = tools.context.createWindow.getMockImplementation()!
  tools.context.createWindow.mockImplementationOnce(() => {
    const window = createWindow()
    if (loader === "cached") Reflect.deleteProperty(window, "syncColorScheme")
    return window
  })
  const { shadow, cleanup } = await startOverlay(tools)
  try {
    await vi.waitFor(() => expect(commentsButton(tools.bar)).not.toBeNull())
    await openList(tools.bar)
    await vi.waitFor(() => expect(tools.panel()?.querySelector('[data-slot="comment-panel"]')).toBeTruthy())
    const window = tools.context.createWindow.mock.results[0]?.value
    await wholePage(tools.bar)
    await vi.waitFor(() => expect(shadow.querySelector('textarea[aria-label="Comment"]')).not.toBeNull())
    expect(window?.hide).toHaveBeenCalledOnce()
  }
  finally {
    cleanup?.()
  }
})

it("toggles pin visibility only once while Shift+C is held", async () => {
  await serveComments({ identify: () => author })
  const tools = pageTools()
  const { bar } = tools
  const { cleanup } = await startOverlay(tools)
  try {
    await vi.waitFor(() => expect(tool(bar, "Hide comments")).not.toBeNull())
    press(document.body, "C", { shiftKey: true })
    await vi.waitFor(() => expect(tool(bar, "Show comments")).not.toBeNull())
    press(document.body, "C", { shiftKey: true, repeat: true })
    await Promise.resolve()
    expect(tool(bar, "Show comments")).not.toBeNull()
  }
  finally {
    cleanup?.()
  }
})
