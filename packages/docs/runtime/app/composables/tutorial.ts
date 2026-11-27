import { useCookie, useState } from "#imports"
import { docsTutorialNavigationCookie } from "#docs/navigation"
import { nextTick } from "vue"

// A page with a collapsed sidebar, such as a code panel tutorial, starts with a narrow strip so the content gets the
// page. Its button opens the sidebar. A cookie keeps the choice, so the server renders the same layout on the next
// visit and nothing jumps.
export function useDocsSidebarExpanded() {
  return useCookie<boolean>(docsTutorialNavigationCookie, {
    default: () => false,
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  })
}

/** Ids of the buttons that open and collapse the sidebar. Only one of them is on the page at a time. */
export const docsSidebarToggleIds = { show: "vh-docs-sidebar-show", hide: "vh-docs-sidebar-hide" } as const

/**
 * Opens or collapses the sidebar and focuses the opposite control after the DOM updates, whether the component mounts
 * or only its toggle prop changes.
 */
export function useDocsSidebarToggle() {
  const expanded = useDocsSidebarExpanded()
  const focus = useState<string | null>("vh-docs-sidebar-focus", () => null)
  function focusMounted() {
    const id = focus.value
    focus.value = null
    if (id) document.getElementById(id)?.focus()
  }
  return {
    expanded,
    toggle(open: boolean) {
      focus.value = open ? docsSidebarToggleIds.hide : docsSidebarToggleIds.show
      expanded.value = open
      void nextTick(focusMounted)
    },
    focusMounted,
  }
}
