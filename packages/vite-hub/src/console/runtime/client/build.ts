import { shallowRef } from "vue"

import type { ShallowRef } from "vue"

import { requestConsole } from "./request"
import { loadConsoleNavigation } from "./sections"

interface PageDocument {
  addEventListener(type: "visibilitychange", listener: () => void): void
  removeEventListener(type: "visibilitychange", listener: () => void): void
  visibilityState: string
}

// The Console helpers compile without DOM types, so the page is read through the few members the check uses.
// doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: The Console runs in a browser, where `document` has these members.
const page = globalThis as unknown as { document: PageDocument }

/** How often a visible Console asks for the deployed build id. */
export const consoleBuildCheckInterval = 60_000
/** A tab that becomes visible again checks at once, but not more often than this. */
const minimumCheckGap = 10_000

const updateReady = shallowRef(false)
const watched = new Set<string>()

/** True when the deployed Console is newer than the Console in this tab. A reload loads it. */
export function useConsoleUpdate(): Readonly<ShallowRef<boolean>> {
  return updateReady
}

/** Reads the build id of the deployed Console. It is `undefined` when the request fails or the server has none. */
export async function readConsoleBuild(base: string): Promise<string | undefined> {
  try {
    const value = await requestConsole(base)
    const build = value instanceof Object ? Reflect.get(value, "build") : undefined
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
    return typeof build === "string" && build ? build : undefined
  }
  catch {
    return undefined
  }
}

/**
 * Starts to compare the build id that this tab loaded with the deployed one, like the Nuxt app manifest.
 * It checks when the tab becomes visible and once a minute while it is visible. It stops after it finds a newer build.
 */
export function watchConsoleBuild(base: string): void {
  if (watched.has(base)) return
  void loadConsoleNavigation(base).then((navigation) => {
    const loaded = navigation?.build
    // A server without a build id cannot tell a newer Console apart.
    if (!loaded) return
    watched.add(base)
    let lastCheck = Date.now()
    let checking = false
    const check = async (): Promise<void> => {
      if (checking || updateReady.value || page.document.visibilityState !== "visible") return
      if (Date.now() - lastCheck < minimumCheckGap) return
      checking = true
      lastCheck = Date.now()
      const deployed = await readConsoleBuild(base)
      checking = false
      if (!deployed || deployed === loaded) return
      updateReady.value = true
      clearInterval(timer)
      page.document.removeEventListener("visibilitychange", onVisibilityChange)
    }
    const onVisibilityChange = (): void => void check()
    const timer = setInterval(onVisibilityChange, consoleBuildCheckInterval)
    page.document.addEventListener("visibilitychange", onVisibilityChange)
  })
}
