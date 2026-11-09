import { useCookie, useState } from "#imports"
import { docsTutorialNavigationCookie } from "#docs/navigation"

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
 * Opens or collapses the sidebar. The button that was pressed leaves the page, so the button that does the opposite
 * takes the focus once it mounts. The component that renders that button calls `focusMounted` from `onMounted`.
 */
export function useDocsSidebarToggle() {
  const expanded = useDocsSidebarExpanded()
  const focus = useState<string | null>("vh-docs-sidebar-focus", () => null)
  return {
    expanded,
    toggle(open: boolean) {
      focus.value = open ? docsSidebarToggleIds.hide : docsSidebarToggleIds.show
      expanded.value = open
    },
    focusMounted() {
      const id = focus.value
      if (!id) return
      const button = document.getElementById(id)
      if (!button) return
      focus.value = null
      button.focus()
    },
  }
}
