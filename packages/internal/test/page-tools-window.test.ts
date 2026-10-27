// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { createViteHubPageWindow } from "../src/runtime/page-tools-window.ts"

afterEach(() => { document.body.replaceChildren(); localStorage.clear() })

describe("page tool window", () => {
  it("keeps the same editor and draft through expansion, minimization and reopening", () => {
    const trigger = document.createElement("button")
    document.body.append(trigger)
    const controller = new AbortController()
    const window = createViteHubPageWindow({ id: "content", title: "Content", trigger, signal: controller.signal })
    const input = document.createElement("textarea")
    window.body.append(input)
    window.show()
    input.value = "A draft that has not saved"
    const host = document.querySelector<HTMLElement>("vitehub-window")!
    host.shadowRoot!.querySelector<HTMLButtonElement>(".expand")!.click()
    expect(host.shadowRoot!.querySelector(".expanded")).not.toBeNull()
    window.hide()
    expect(host.hidden).toBe(true)
    expect(document.activeElement).toBe(trigger)
    window.show()
    expect(window.body.firstChild).toBe(input)
    expect(input.value).toBe("A draft that has not saved")
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    controller.abort()
    expect(document.querySelector("vitehub-window")).toBeNull()
  })
})
