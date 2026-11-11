/** The frameworks of `::tabs{sync="framework"}` blocks, in tab order. */
export const frameworks = ["Nuxt", "Nitro", "Vite"] as const
export type Framework = typeof frameworks[number]

// comark-ui's tabs keep the label of the synced tab here, and Nuxt UI's prose tabs keep its index.
const comarkKey = "comark-tabs:framework"
const nuxtUiKey = "tabs-framework"
const tabSelector = '.ct[data-tabs-sync="framework"] > .ct-list > [role=tab]'

export function isFramework(value: unknown): value is Framework {
  return frameworks.some(framework => framework === value)
}

function readSaved(): Framework | undefined {
  try {
    const label = localStorage.getItem(comarkKey)
    if (isFramework(label)) return label
    const index = Number(localStorage.getItem(nuxtUiKey))
    return frameworks[index]
  }
  catch {
    // Storage can throw with cookies blocked. The page then shows the first framework.
    return undefined
  }
}

let listening = false

/**
 * The framework that the reader picked in a framework tab or a landing hero, saved in localStorage so every page
 * opens on it. comark-ui's tabs save a click themselves, so this value follows them, and a change here clicks them.
 */
export function useFramework() {
  const state = useState<Framework | null>("vitehub-framework", () => null)
  onMounted(() => {
    state.value ??= readSaved() ?? null
    if (listening) return
    listening = true
    // A tab click or arrow key runs comark-ui's handler first, which saves the new label.
    const follow = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.closest(tabSelector)) return
      queueMicrotask(() => {
        const saved = readSaved()
        if (saved) state.value = saved
      })
    }
    document.addEventListener("click", follow)
    document.addEventListener("keyup", follow)
  })
  return computed<Framework>({
    get: () => state.value ?? frameworks[0],
    set(framework) {
      state.value = framework
      const tab = [...document.querySelectorAll<HTMLElement>(tabSelector)].find(tab => tab.textContent?.trim() === framework)
      if (tab) {
        if (tab.getAttribute("aria-selected") !== "true") tab.click()
        return
      }
      try {
        localStorage.setItem(comarkKey, framework)
        localStorage.setItem(nuxtUiKey, String(frameworks.indexOf(framework)))
      }
      catch {
        // The choice still applies to this page.
      }
    },
  })
}
