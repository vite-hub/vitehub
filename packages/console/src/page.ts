/** The first paint of the Console page. The page draws the frame of this view until its app mounts. */
export type ConsolePageBoot = "app" | "invite" | "shell" | "sign-in"

/**
 * The view that the last visit ended on, `app` or `shell`. The page writes it (vite-hub's console `main.js`), so the
 * next visit to `/` draws that frame before it knows if the app answers.
 */
export const consoleViewCookie = "vitehub-console-view"

const sessionCookie = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/
const appView = new RegExp(`(?:^|;\\s*)${consoleViewCookie}=app(?:;|$)`)

/**
 * Which view a request opens, from its path and its cookies only, so the page needs no database read. A stale session
 * cookie draws the team frame before the sign-in page. That costs one change of frame, as before.
 */
export function consolePageBoot(request: Request): ConsolePageBoot {
  const { pathname } = new URL(request.url)
  if (pathname.startsWith("/invite/")) return "invite"
  const cookies = request.headers.get("cookie") ?? ""
  if (!sessionCookie.test(cookies)) return "sign-in"
  if (/^\/(?:home|team|settings)\/?$/.test(pathname)) return "shell"
  if (pathname === "/") return appView.test(cookies) ? "app" : "shell"
  // Other paths, such as /logs, are pages of an open app.
  return "app"
}

/** The page with the first paint of the request's view. A page of the sidebar also marks its row. */
export function renderConsolePage(html: string, request: Request): string {
  const boot = consolePageBoot(request)
  const page = boot === "shell" ? /^\/(home|team|settings)\/?$/.exec(new URL(request.url).pathname)?.[1] ?? "" : ""
  return html.replace('data-vitehub-boot="app" data-vitehub-page=""', `data-vitehub-boot="${boot}" data-vitehub-page="${page}"`)
}
