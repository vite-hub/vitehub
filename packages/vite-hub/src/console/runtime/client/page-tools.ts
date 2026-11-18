import { viteHubBasePath, viteHubPageToolsLoader, viteHubPageToolsWanted } from "@vite-hub/internal/runtime/page-tools-shared"

/**
 * Loads the page tools of the Console page, such as Comments for the people in VITEHUB_CONSOLE_COMMENTERS, after the
 * Console mounts. The page has the page tools marker (`hosted/account.html`), so the server adds no loader or check of
 * its own, and the session check and the tool code do not run next to the Console's boot reads and mount. It uses the
 * same rule as the server's check: without the hint, it makes no request.
 */
export function loadConsolePageTools(
  base: string,
  page: { search: string, cookie: string },
  load: (url: string) => Promise<unknown> = url => import(/* @vite-ignore */ url),
): Promise<unknown> | undefined {
  if (!viteHubPageToolsWanted(page.search, page.cookie)) return undefined
  return load(`${viteHubBasePath(base)}${viteHubPageToolsLoader}`).catch(() => undefined)
}
