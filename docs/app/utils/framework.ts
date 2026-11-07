/** The frameworks of `::tabs{sync="framework"}` blocks, in tab order. */
export const frameworks = ["Nuxt", "Nitro", "Vite"] as const
export type Framework = typeof frameworks[number]

// Nuxt UI's prose tabs keep the index of the synced tab here, and comark-ui's tabs keep its label.
const tabsKey = "tabs-framework"
const comarkKey = "comark-tabs:framework"

function isFramework(value: unknown): value is Framework {
  return frameworks.some(framework => framework === value)
}

/**
 * The framework that the reader picked in any framework tab, saved in localStorage so every page opens on it.
 * It shares Nuxt UI's `tabs-framework` state, so a tab click and this value change together.
 */
export function useFramework() {
  const index = useState<string | null>(tabsKey, () => null)
  onMounted(() => {
    if (index.value !== null) return
    try {
      const saved = localStorage.getItem(tabsKey)
      const label = localStorage.getItem(comarkKey)
      if (saved !== null) index.value = saved
      else if (isFramework(label)) index.value = String(frameworks.indexOf(label))
    }
    catch {
      // Storage can throw with cookies blocked. The page then shows the first framework.
    }
  })
  return computed<Framework>({
    get: () => frameworks[Number(index.value ?? 0)] ?? frameworks[0],
    set(framework) {
      index.value = String(frameworks.indexOf(framework))
      try {
        localStorage.setItem(tabsKey, index.value)
        localStorage.setItem(comarkKey, framework)
      }
      catch {
        // The choice still applies to this page.
      }
    },
  })
}
