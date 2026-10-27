/** The members of the Console page that the sign-in link reads. */
export interface ConsoleSignInPage {
  document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null }
  location: { origin: string, pathname: string, search: string }
}

/**
 * Where the Console sends a person to sign in, with `redirect` set to the Console page they are on. The Console page
 * names the sign-in page in a meta tag when its access policy has one: the app's `console.signInPage`, or the sign-in
 * page of Console Auth. Returns `undefined` without one.
 */
export function consoleSignInURL(page: ConsoleSignInPage): string | undefined {
  const signInPage = page.document.querySelector('meta[name="vitehub-console-sign-in"]')?.getAttribute("content")
  if (!signInPage || !/^\/(?!\/)[^\\\s]*$/.test(signInPage)) return undefined
  const url = new URL(signInPage, page.location.origin)
  if (url.origin !== page.location.origin || url.pathname.startsWith("//")) return undefined
  url.searchParams.set("redirect", `${page.location.pathname}${page.location.search}`)
  return `${url.pathname}${url.search}${url.hash}`
}
