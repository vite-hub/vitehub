import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"

import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { afterEach, expect, it, vi } from "vitest"
import { nextTick, ref, watchEffect, type Ref } from "vue"

// App auto-imports are supplied by Nuxt, outside the package's server-only TypeScript declarations.
const source = readFileSync(resolve(import.meta.dirname, "../runtime/app/composables/tutorial.ts"), "utf8")
const script = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ESNext } }).outputText
const state = new Map<string, Ref<unknown>>()
const exports = {} as {
  docsSidebarToggleIds: Record<"show" | "hide", string>
  useDocsSidebarToggle: () => { expanded: Ref<boolean>, toggle: (open: boolean) => void, focusMounted: () => void }
}
runInNewContext(script, {
  exports,
  get document() { return globalThis.document },
  require: (id: string) => {
    if (id === "vue") return { nextTick }
    if (id === "#docs/navigation") return { docsTutorialNavigationCookie: "vh-tutorial-navigation" }
    if (id === "#imports") return {
      useCookie: () => ref(false),
      useState: (key: string, init: () => unknown) => {
        if (!state.has(key)) state.set(key, ref(init()))
        return state.get(key)
      },
    }
    throw new Error(`Unexpected composable import: ${id}`)
  },
})
const { docsSidebarToggleIds, useDocsSidebarToggle } = exports

afterEach(() => {
  vi.unstubAllGlobals()
  state.clear()
})

it("focuses the opposite toggle after a mounted rail updates, in both directions", async () => {
  const { expanded, toggle } = useDocsSidebarToggle()
  let button = { id: "", focus: vi.fn() }
  // The rail stays mounted while Vue updates its toggle prop and button id.
  const stop = watchEffect(() => {
    button = { id: docsSidebarToggleIds[expanded.value ? "hide" : "show"], focus: vi.fn() }
  })
  vi.stubGlobal("document", { getElementById: (id: string) => button.id === id ? button : null })
  try {
    for (const open of [true, false]) {
      toggle(open)
      await nextTick()
      expect(button.id).toBe(docsSidebarToggleIds[open ? "hide" : "show"])
      expect(button.focus).toHaveBeenCalledOnce()
    }
  }
  finally {
    stop()
  }
})

it("does not carry a missing focus target into a later unrelated mount", async () => {
  const getElementById = vi.fn(() => null)
  vi.stubGlobal("document", { getElementById })
  const { toggle } = useDocsSidebarToggle()
  toggle(true)
  await nextTick()
  expect(getElementById).toHaveBeenCalledWith(docsSidebarToggleIds.hide)
  // A subsequent composable instance must have no pending focus request.
  useDocsSidebarToggle().focusMounted()
  await nextTick()
  expect(getElementById).toHaveBeenCalledTimes(1)
})
