import { useCookie } from "#imports"
import { docsTutorialNavigationCookie } from "#docs/navigation"

// Tutorials with a code panel start with the docs navigation hidden, so the prose and the files get the page.
// The button in the top left corner opens it. A cookie keeps the choice,
// so the server renders the same layout on the next visit and nothing jumps.
export function useTutorialNavigation() {
  return useCookie<boolean>(docsTutorialNavigationCookie, {
    default: () => false,
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  })
}
