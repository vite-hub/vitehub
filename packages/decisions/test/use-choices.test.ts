import { effectScope, nextTick } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useChoices } from "../src/vue.ts"

import type { UseChoicesOptions } from "../src/vue.ts"

type Selection = { supplier: string[] }

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function setup(options: UseChoicesOptions<Selection>) {
  const scope = effectScope()
  const choices = scope.run(() => useChoices<Selection>(options))!
  return { choices, scope }
}

/** A request that you finish by hand, and that rejects when its signal aborts. */
function pending() {
  const requests: { resolve: (value: Selection) => void, signal: AbortSignal, text: string }[] = []
  const resolve: UseChoicesOptions<Selection>["resolve"] = (text, { signal }) => new Promise((done, fail) => {
    requests.push({ resolve: done, signal, text })
    signal.addEventListener("abort", () => fail(new DOMException("aborted", "AbortError")))
  })
  return { requests, resolve }
}

describe("useChoices()", () => {
  it("goes from idle to thinking to ready and calls onSelect", async () => {
    const onSelect = vi.fn()
    const { choices } = setup({ onSelect, resolve: async () => ({ supplier: ["S2"] }) })
    expect(choices.status.value).toBe("idle")
    choices.text.value = "nord parts"
    const done = choices.submit()
    expect(choices.status.value).toBe("thinking")
    await done
    expect(choices.status.value).toBe("ready")
    expect(choices.selection.value).toEqual({ supplier: ["S2"] })
    expect(onSelect).toHaveBeenCalledWith({ supplier: ["S2"] })
  })

  it("sets error and status when the request throws", async () => {
    const { choices } = setup({ resolve: async () => { throw new Error("422 unsupported") } })
    choices.text.value = "nord parts"
    await choices.submit()
    expect(choices.status.value).toBe("error")
    expect(choices.error.value?.message).toBe("422 unsupported")
    expect(choices.selection.value).toBeUndefined()
  })

  it("does nothing for empty text", async () => {
    const resolve = vi.fn(async () => ({ supplier: [] }))
    const { choices } = setup({ resolve })
    choices.text.value = "   "
    await choices.submit()
    expect(resolve).not.toHaveBeenCalled()
    expect(choices.status.value).toBe("idle")
  })

  it("cancels the older request when a newer one starts and ignores its result", async () => {
    const { requests, resolve } = pending()
    const { choices } = setup({ resolve })
    choices.text.value = "first text"
    const first = choices.submit()
    choices.text.value = "second text"
    const second = choices.submit()
    expect(requests[0]?.signal.aborted).toBe(true)
    requests[1]?.resolve({ supplier: ["S2"] })
    await Promise.all([first, second])
    expect(choices.selection.value).toEqual({ supplier: ["S2"] })
    expect(choices.error.value).toBeUndefined()
    expect(choices.status.value).toBe("ready")
  })

  it("abort() goes back to idle without an error", async () => {
    const { requests, resolve } = pending()
    const { choices } = setup({ resolve })
    choices.text.value = "nord parts"
    const done = choices.submit()
    choices.abort()
    await done
    expect(requests[0]?.signal.aborted).toBe(true)
    expect(choices.status.value).toBe("idle")
    expect(choices.error.value).toBeUndefined()
  })

  it("clear() resets text, selection, and error", async () => {
    const { choices } = setup({ resolve: async () => ({ supplier: ["S1"] }) })
    choices.text.value = "vak supply"
    await choices.submit()
    choices.clear()
    expect(choices.text.value).toBe("")
    expect(choices.selection.value).toBeUndefined()
    expect(choices.status.value).toBe("idle")
  })

  it("clear() calls onClear so the app can reset its own state", async () => {
    const onClear = vi.fn()
    const { choices } = setup({ onClear, resolve: async () => ({ supplier: ["S1"] }) })
    choices.text.value = "vak supply"
    await choices.submit()
    choices.abort()
    expect(onClear).not.toHaveBeenCalled()
    choices.clear()
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it("aborts the request when its scope stops", async () => {
    const { requests, resolve } = pending()
    const { choices, scope } = setup({ resolve })
    choices.text.value = "nord parts"
    void choices.submit()
    scope.stop()
    expect(requests[0]?.signal.aborted).toBe(true)
  })
})

describe("useChoices() debounce", () => {
  it("resolves once after the last keystroke", async () => {
    const resolve = vi.fn(async (_text: string) => ({ supplier: ["S2"] }))
    const { choices } = setup({ debounce: 500, resolve })
    for (const text of ["nor", "nord", "nord parts"]) {
      choices.text.value = text
      await nextTick()
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(resolve).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(400)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0]?.[0]).toBe("nord parts")
    expect(choices.status.value).toBe("ready")
  })

  it("does not resolve text below minLength and cancels a pending request", async () => {
    const { requests, resolve } = pending()
    const { choices } = setup({ debounce: 100, resolve })
    choices.text.value = "nord"
    await nextTick()
    await vi.advanceTimersByTimeAsync(150)
    expect(requests).toHaveLength(1)
    choices.text.value = "no"
    await nextTick()
    expect(requests[0]?.signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    expect(requests).toHaveLength(1)
    expect(choices.status.value).toBe("idle")
  })

  it("only resolves on submit() without a debounce", async () => {
    const resolve = vi.fn(async () => ({ supplier: [] }))
    const { choices } = setup({ resolve })
    choices.text.value = "nord parts"
    await nextTick()
    await vi.advanceTimersByTimeAsync(5000)
    expect(resolve).not.toHaveBeenCalled()
  })
})
