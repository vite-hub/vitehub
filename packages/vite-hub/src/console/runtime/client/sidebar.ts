import { computed, ref } from "vue"
import type { DropdownMenuItem } from "@nuxt/ui"

/** The browser keeps the person's choice: `open` shows the labels, `closed` keeps the icon rail. */
export const consoleSidebarStorageKey = "vitehub-console:sidebar"

/** Below this width the open sidebar covers the page as a drawer, and the choice is not kept. */
const drawerQuery = "(max-width: 47.999rem)"

function readOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(consoleSidebarStorageKey) === "open"
  }
  catch {
    return false
  }
}

interface ConsoleMediaQuery {
  readonly matches: boolean
  addEventListener(type: "change", listener: () => void): void
}

const pinned = ref(readOpen())
const drawer = ref(false)

// The server program has no DOM types, so the media query reads only what the sidebar needs.
const matchMedia: unknown = Reflect.get(globalThis, "matchMedia")
// SAFETY: `matchMedia` is the browser function, which returns a MediaQueryList with these members.
const media = typeof matchMedia === "function" ? (matchMedia as (query: string) => ConsoleMediaQuery).call(globalThis, drawerQuery) : undefined
const narrow = ref(media?.matches ?? false)
media?.addEventListener("change", () => {
  narrow.value = media.matches
  drawer.value = false
})

/** The sidebar shows its labels: pinned open on a wide screen, or open as a drawer on a narrow one. */
export const consoleSidebarOpen = computed(() => narrow.value ? drawer.value : pinned.value)

/** The sidebar covers the page instead of moving it, on a narrow screen. */
export const consoleSidebarDrawer = computed(() => narrow.value)

/** Open or close the sidebar. A wide screen keeps the choice for the next visit. */
export function setConsoleSidebarOpen(open: boolean): void {
  if (narrow.value) {
    drawer.value = open
    return
  }
  pinned.value = open
  try {
    globalThis.localStorage?.setItem(consoleSidebarStorageKey, open ? "open" : "closed")
  }
  catch {}
}

export function toggleConsoleSidebar(): void {
  setConsoleSidebarOpen(!consoleSidebarOpen.value)
}

/** A drawer closes after a page change, so the page that opened is not covered. */
export function closeConsoleSidebarDrawer(): void {
  drawer.value = false
}

/** The Docs row of the user menu. It opens the Console docs in a new tab. */
export const consoleDocsItem: DropdownMenuItem = {
  icon: "i-lucide-book-open",
  label: "Docs",
  to: "https://vitehub.dev/docs/development/console",
  target: "_blank",
  trailingIcon: "i-lucide-arrow-up-right",
}

/** Each request to open the search palette, from the Search row of the sidebar. The palette of the page watches it. */
export const consoleSearchRequests = ref(0)

export function openConsoleSearch(): void {
  consoleSearchRequests.value++
}
